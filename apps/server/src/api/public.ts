/**
 * Public read API (docs/BRIEF.md §9). No PII is ever returned: crews appear only through
 * anonymised policy ids and payment proofs.
 */
import { getPublicKey, parseAttestation, type NostrEvent } from '@ndox/oracle';
import { addDays, getSite, isSiteId, SITES } from '@ndox/shared';
import { and, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { cmToM } from '../db/index.js';
import { attestations, forecasts, payouts, sites } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { isoDate, isoSeconds } from '../lib/time.js';
import {
  announcementContent,
  getAnnouncement,
  getAttestation,
  getForecasts,
  ruleFor,
  SCHEDULE,
  type AttestationRow,
} from '../oracle/jobs.js';
import type { Services } from '../services.js';

const EVENT_ID = /^ndox(-replay)?:[a-z0-9-]+:\d{4}-\d{2}-\d{2}(:[a-z0-9-]+)?$/;

const SiteParam = z.object({ site: z.string().refine(isSiteId, 'unknown site') });
const EventParam = z.object({ eventId: z.string().regex(EVENT_ID) });
const RawParam = EventParam.extend({ model: z.string().regex(/^[a-z0-9_]{1,40}$/) });
const ListQuery = z.object({
  site: z.string().refine(isSiteId, 'unknown site').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  replay: z.enum(['0', '1']).default('0'),
});

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'bad_request',
    issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
}

function attestationSummary(a: AttestationRow) {
  return {
    eventId: a.eventId,
    site: a.site,
    date: a.date,
    replay: a.replayRunId !== null,
    replayRunId: a.replayRunId,
    outcome: a.outcome,
    decisiveM: a.decisiveM,
    nostrId: a.nostrId,
    createdAt: a.createdAt,
    publishedAt: a.publishedAt,
  };
}

function attestedModels(a: AttestationRow) {
  const { content } = parseAttestation(JSON.parse(a.eventJson));
  return content.data.models.map((m) => ({
    id: m.id,
    windowMaxM: m.windowMaxM,
    validHours: m.validHours,
  }));
}

export function registerPublicRoutes(app: FastifyInstance, s: Services): void {
  const { db, config } = s;
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  app.get('/api/meta', async (_req, reply) => {
    noStore(reply);
    return {
      oraclePubkey: getPublicKey(config.secrets.oracle),
      demoOraclePubkey: getPublicKey(config.secrets.demoOracle),
      poolPubkey: getPublicKey(config.secrets.pool),
      relays: config.relays,
      nostrPublish: config.nostrPublish,
      network: config.network,
      walletMode: config.walletMode,
      schedule: SCHEDULE,
      window: { start: '06:00', end: '18:00', timezone: 'UTC' },
    };
  });

  app.get('/api/sites', async () => {
    const rows = db.select().from(sites).all();
    const month = s.clock().getUTCMonth() + 1;
    return SITES.map((site) => {
      const row = rows.find((r) => r.id === site.id);
      return {
        id: site.id,
        name: site.name,
        lat: site.lat,
        lon: site.lon,
        seasonMonths: site.seasonMonths,
        inSeason: site.seasonMonths.includes(month),
        thresholdM: row ? cmToM(row.thresholdCm) : config.defaultThresholdM,
        enabled: row?.enabled ?? false,
      };
    });
  });

  app.get('/api/today', async (_req, reply) => {
    noStore(reply);
    const now = s.clock();
    const date = isoDate(now);
    const tomorrow = addDays(date, 1);
    const rows = db.select().from(sites).all();
    return {
      date,
      now: isoSeconds(now),
      sites: SITES.map((site) => {
        const row = rows.find((r) => r.id === site.id);
        const ann = getAnnouncement(db, `ndox:${site.id}:${date}`);
        const att = getAttestation(db, `ndox:${site.id}:${date}`);
        const next = getAnnouncement(db, `ndox:${site.id}:${tomorrow}`);
        return {
          id: site.id,
          name: site.name,
          thresholdM: row ? cmToM(row.thresholdCm) : config.defaultThresholdM,
          enabled: row?.enabled ?? false,
          inSeason: site.seasonMonths.includes(now.getUTCMonth() + 1),
          announcement: ann
            ? {
                eventId: ann.eventId,
                nostrId: ann.nostrId,
                noncePoint: ann.noncePoint,
                createdAt: ann.createdAt,
                publishedAt: ann.publishedAt,
                attestAt: announcementContent(ann).content.attestAt,
              }
            : null,
          attestation: att ? { ...attestationSummary(att), models: attestedModels(att) } : null,
          tomorrow: next
            ? { eventId: next.eventId, createdAt: next.createdAt, publishedAt: next.publishedAt }
            : null,
        };
      }),
    };
  });

  app.get('/api/forecast/:site', async (req, reply) => {
    const p = SiteParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const site = getSite(p.data.site);
    if (!site) return reply.code(404).send({ error: 'not_found' });
    try {
      const outlook = await s.outlook.get(site, ruleFor(db, site.id));
      return reply.header('cache-control', 'public, max-age=600').send(outlook);
    } catch (err) {
      s.log.warn('outlook unavailable', { site: site.id, error: errorMessage(err) });
      return reply.code(503).send({ error: 'forecast_unavailable' });
    }
  });

  app.get('/api/attestations', async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);
    const where: SQL[] = [
      q.data.replay === '1'
        ? isNotNull(attestations.replayRunId)
        : isNull(attestations.replayRunId),
    ];
    if (q.data.site) where.push(eq(attestations.site, q.data.site));
    const rows = db
      .select()
      .from(attestations)
      .where(and(...where))
      .orderBy(desc(attestations.date), desc(attestations.createdAt))
      .limit(q.data.limit)
      .all();
    noStore(reply);
    return { items: rows.map(attestationSummary) };
  });

  app.get('/api/attestations/:eventId', async (req, reply) => {
    const p = EventParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const { eventId } = p.data;
    const ann = getAnnouncement(db, eventId);
    if (!ann) return reply.code(404).send({ error: 'not_found' });
    const att = getAttestation(db, eventId);
    const rawBase = `/api/attestations/${encodeURIComponent(eventId)}/raw/`;
    const payoutRows = att
      ? db
          .select({
            id: payouts.id,
            policyId: payouts.policyId,
            amountFcfa: payouts.amountFcfa,
            dueSat: payouts.dueSat,
            amountSat: payouts.amountSat,
            factorPpm: payouts.factorPpm,
            status: payouts.status,
            paymentHash: payouts.paymentHash,
            preimage: payouts.preimage,
            receiptJson: payouts.receiptJson,
            createdAt: payouts.createdAt,
          })
          .from(payouts)
          .where(eq(payouts.attestationId, eventId))
          .all()
      : [];
    noStore(reply);
    return {
      eventId,
      site: ann.site,
      date: ann.date,
      replay: ann.replayRunId !== null,
      replayRunId: ann.replayRunId,
      announcement: {
        event: JSON.parse(ann.eventJson) as NostrEvent,
        nostrId: ann.nostrId,
        createdAt: ann.createdAt,
        publishedAt: ann.publishedAt,
      },
      attestation: att
        ? {
            event: JSON.parse(att.eventJson) as NostrEvent,
            nostrId: att.nostrId,
            outcome: att.outcome,
            decisiveM: att.decisiveM,
            createdAt: att.createdAt,
            publishedAt: att.publishedAt,
          }
        : null,
      forecasts: getForecasts(db, eventId).map((f) => ({
        model: f.model,
        url: f.url,
        status: f.status,
        fetchedAt: f.fetchedAt,
        sha256: f.sha256,
        windowMaxM: f.windowMaxM,
        validHours: f.validHours,
        error: f.error,
        rawUrl: f.status === 'ok' ? rawBase + f.model : null,
      })),
      payouts: payoutRows.map(({ receiptJson, ...rest }) => ({
        ...rest,
        receipt: receiptJson ? (JSON.parse(receiptJson) as NostrEvent) : null,
      })),
    };
  });

  app.get('/api/attestations/:eventId/raw/:model', async (req, reply) => {
    const p = RawParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const row = db
      .select({ body: forecasts.body, sha256: forecasts.sha256 })
      .from(forecasts)
      .where(
        and(
          eq(forecasts.eventId, p.data.eventId),
          eq(forecasts.model, p.data.model),
          eq(forecasts.status, 'ok'),
        ),
      )
      .get();
    if (!row?.body) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-content-sha256', row.sha256 ?? '')
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(row.body);
  });

  let backtest: Promise<string> | null = null;
  app.get('/api/backtest', async (_req, reply) => {
    backtest ??= readFile(join(config.seedDir, 'backtest.json'), 'utf8');
    try {
      const body = await backtest;
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('cache-control', 'public, max-age=3600')
        .send(body);
    } catch {
      backtest = null;
      return reply.code(404).send({ error: 'backtest_missing' });
    }
  });
}
