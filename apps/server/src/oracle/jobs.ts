/**
 * The oracle's daily jobs (docs/BRIEF.md §3). Each job is idempotent and crash-safe:
 *
 *   announce  ensure the announcement row exists (fresh nonce, sealed), then ensure it is published
 *   fetch     store the latest raw responses of both models — refused once an attestation exists
 *   attest    sign the outcome with the committed nonce; the attestation row is inserted and the
 *             nonce deleted in ONE transaction, so a re-run finds the attestation and never signs
 *             again (signing twice with one nonce would leak the oracle key)
 *
 * Signing happens inside synchronous SQLite transactions (better-sqlite3), so two concurrent
 * callers in one process cannot both pass the "already exists?" check.
 */
import {
  buildAnnouncement,
  buildAttestation,
  eventIdFor,
  generateNonce,
  getPublicKey,
  parseAnnouncement,
  verifyAttestationEvent,
  type AnnouncementContent,
  type ModelObservation,
  type NostrEvent,
  type RuleSpec,
} from '@ndox/oracle';
import {
  decideOutcome,
  getSite,
  LIVE_MODELS,
  parseMarineResponse,
  seriesFromResponse,
  windowStats,
  type SiteConfig,
} from '@ndox/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { cmToM } from '../db/index.js';
import { announcements, attestations, forecasts, sites } from '../db/schema.js';
import { open, seal } from '../lib/box.js';
import { errorMessage, type Log } from '../lib/log.js';
import { atUtc, isoSeconds, isValidDate, unixSeconds, type Clock } from '../lib/time.js';
import { dueForRetry, type Publisher, type PublishResult } from '../nostr/publisher.js';
import { urlFor, type ForecastSource } from '../wave/source.js';

/** UTC times of the daily loop. */
export const SCHEDULE = { announce: '20:00', fetch: '05:00', attest: '05:15' } as const;
export const MIN_VALID_HOURS = 10;
export const RULE_LOGIC =
  "danger if every model's 06:00-18:00 UTC max >= thresholdM; indisponible if a model is missing " +
  'or has fewer than minValidHours valid hours; otherwise calme';

export interface OracleCtx {
  db: Db;
  /** Oracle secret (live) or demo oracle secret (replay). */
  secret: string;
  /** AES-GCM key sealing nonces at rest (derived from the secret above). */
  nonceKey: Buffer;
  source: ForecastSource;
  /** null = dry run: sign and store, but do not publish. */
  publisher: Publisher | null;
  relays: string[];
  clock: Clock;
  /** Set for demo replays (separate event ids, `ndox-replay` tag). */
  replayRunId?: string | undefined;
  log: Log;
}

export class JobError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type AnnouncementRow = typeof announcements.$inferSelect;
export type AttestationRow = typeof attestations.$inferSelect;
export type ForecastRow = typeof forecasts.$inferSelect;

function requireSite(id: string): SiteConfig {
  const site = getSite(id);
  if (!site) throw new JobError('unknown_site', `unknown site ${id}`);
  return site;
}

function requireDate(date: string): void {
  if (!isValidDate(date)) throw new JobError('invalid_date', `invalid date ${date}`);
}

export function ruleFor(db: Db, siteId: string): RuleSpec {
  const row = db.select().from(sites).where(eq(sites.id, siteId)).get();
  if (!row) throw new JobError('unknown_site', `unknown site ${siteId}`);
  return {
    variable: 'wave_height',
    thresholdM: cmToM(row.thresholdCm),
    models: [...LIVE_MODELS],
    minValidHours: MIN_VALID_HOURS,
    logic: RULE_LOGIC,
  };
}

export function getAnnouncement(db: Db, eventId: string): AnnouncementRow | undefined {
  return db.select().from(announcements).where(eq(announcements.eventId, eventId)).get();
}

export function getAttestation(db: Db, eventId: string): AttestationRow | undefined {
  return db.select().from(attestations).where(eq(attestations.eventId, eventId)).get();
}

export function getForecasts(db: Db, eventId: string): ForecastRow[] {
  return db.select().from(forecasts).where(eq(forecasts.eventId, eventId)).all();
}

export function announcementContent(row: AnnouncementRow): {
  event: NostrEvent;
  content: AnnouncementContent;
} {
  return parseAnnouncement(JSON.parse(row.eventJson));
}

// ---------------------------------------------------------------------------
// Publishing

async function publishRow(
  ctx: OracleCtx,
  kind: 'announcement' | 'attestation',
  eventId: string,
): Promise<boolean> {
  const row =
    kind === 'announcement' ? getAnnouncement(ctx.db, eventId) : getAttestation(ctx.db, eventId);
  if (!row) return false;
  if (row.publishedAt) return true;
  if (!ctx.publisher) return false;
  let result: PublishResult;
  try {
    result = await ctx.publisher.publish(JSON.parse(row.eventJson) as NostrEvent);
  } catch (err) {
    result = {
      ok: false,
      accepted: [],
      rejected: [{ relay: '*', reason: errorMessage(err) }],
      at: new Date().toISOString(),
    };
  }
  const set = {
    publishResult: result,
    publishedAt: result.ok ? isoSeconds(new Date(result.at)) : null,
  };
  if (kind === 'announcement') {
    ctx.db.update(announcements).set(set).where(eq(announcements.eventId, eventId)).run();
  } else {
    ctx.db.update(attestations).set(set).where(eq(attestations.eventId, eventId)).run();
  }
  if (result.ok) ctx.log.info(`${kind} published`, { eventId, relays: result.accepted.length });
  else
    ctx.log.warn(`${kind} not published`, {
      eventId,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
    });
  return result.ok;
}

// ---------------------------------------------------------------------------
// announce

export interface AnnounceResult {
  eventId: string;
  nostrId: string;
  noncePoint: string;
  created: boolean;
  published: boolean;
}

export async function announce(
  ctx: OracleCtx,
  siteId: string,
  date: string,
): Promise<AnnounceResult> {
  const site = requireSite(siteId);
  requireDate(date);
  const eventId = eventIdFor(site.id, date, ctx.replayRunId);
  let created = false;
  let row = getAnnouncement(ctx.db, eventId);
  if (!row) {
    const now = ctx.clock();
    const attestAt = atUtc(date, SCHEDULE.attest);
    if (now >= attestAt) {
      throw new JobError(
        'too_late',
        `${eventId}: an announcement must precede ${isoSeconds(attestAt)}`,
      );
    }
    const rule = ruleFor(ctx.db, site.id);
    row = ctx.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(announcements)
        .where(eq(announcements.eventId, eventId))
        .get();
      if (existing) return existing;
      const nonce = generateNonce();
      const { event } = buildAnnouncement({
        secret: ctx.secret,
        site: site.id,
        date,
        noncePoint: nonce.noncePoint,
        rule,
        createdAt: unixSeconds(now),
        relays: ctx.relays,
        siteName: site.name,
        attestTime: SCHEDULE.attest,
        replayRunId: ctx.replayRunId,
      });
      tx.insert(announcements)
        .values({
          eventId,
          site: site.id,
          date,
          replayRunId: ctx.replayRunId ?? null,
          oraclePubkey: event.pubkey,
          noncePoint: nonce.noncePoint,
          nonceEnc: seal(ctx.nonceKey, nonce.k, eventId),
          nostrId: event.id,
          eventJson: JSON.stringify(event),
          createdAt: isoSeconds(new Date(event.created_at * 1000)),
        })
        .run();
      created = true;
      return tx
        .select()
        .from(announcements)
        .where(eq(announcements.eventId, eventId))
        .get() as AnnouncementRow;
    });
    if (created) ctx.log.info('announcement created', { eventId, noncePoint: row.noncePoint });
  }
  const published = await publishRow(ctx, 'announcement', eventId);
  return { eventId, nostrId: row.nostrId, noncePoint: row.noncePoint, created, published };
}

// ---------------------------------------------------------------------------
// fetch

export interface FetchModelResult {
  model: string;
  ok: boolean;
  windowMaxM?: number | null;
  validHours?: number;
  error?: string;
}

export interface FetchResult {
  eventId: string;
  status: 'fetched' | 'skipped';
  reason?: string;
  models: FetchModelResult[];
}

export async function fetchForecasts(
  ctx: OracleCtx,
  siteId: string,
  date: string,
): Promise<FetchResult> {
  const site = requireSite(siteId);
  requireDate(date);
  const eventId = eventIdFor(site.id, date, ctx.replayRunId);
  const ann = getAnnouncement(ctx.db, eventId);
  if (!ann) throw new JobError('no_announcement', `${eventId} was not announced`);
  if (getAttestation(ctx.db, eventId))
    return { eventId, status: 'skipped', reason: 'already_attested', models: [] };
  const { content } = announcementContent(ann);

  const results: FetchModelResult[] = [];
  for (const model of content.rule.models) {
    const q = { site, model, startDate: date, endDate: date };
    let values: typeof forecasts.$inferInsert;
    let result: FetchModelResult;
    try {
      const env = await ctx.source.get(q);
      const series = seriesFromResponse(parseMarineResponse(env.body), content.rule.variable);
      const stats = windowStats(series.time, series.values, content.window);
      values = {
        eventId,
        model,
        url: env.url,
        status: 'ok',
        fetchedAt: env.fetchedAt,
        sha256: env.sha256,
        body: env.body,
        windowMaxM: stats.windowMaxM,
        validHours: stats.validHours,
        error: null,
      };
      result = { model, ok: true, windowMaxM: stats.windowMaxM, validHours: stats.validHours };
    } catch (err) {
      const message = errorMessage(err).slice(0, 300);
      values = {
        eventId,
        model,
        url: urlFor(q),
        status: 'error',
        fetchedAt: isoSeconds(ctx.clock()),
        sha256: null,
        body: null,
        windowMaxM: null,
        validHours: 0,
        error: message,
      };
      result = { model, ok: false, error: message };
    }
    const stored = ctx.db.transaction((tx) => {
      // Data is frozen once attested: the published hashes must keep matching the stored bodies.
      if (tx.select().from(attestations).where(eq(attestations.eventId, eventId)).get())
        return false;
      const prev = tx
        .select()
        .from(forecasts)
        .where(and(eq(forecasts.eventId, eventId), eq(forecasts.model, model)))
        .get();
      // A failed retry never replaces an earlier good response.
      if (values.status === 'error' && prev?.status === 'ok') return true;
      tx.insert(forecasts)
        .values(values)
        .onConflictDoUpdate({ target: [forecasts.eventId, forecasts.model], set: values })
        .run();
      return true;
    });
    if (!stored) return { eventId, status: 'skipped', reason: 'already_attested', models: results };
    results.push(result);
    if (!result.ok) ctx.log.warn('forecast fetch failed', { eventId, model, error: result.error });
  }
  return { eventId, status: 'fetched', models: results };
}

// ---------------------------------------------------------------------------
// attest

export interface AttestResult {
  eventId: string;
  nostrId: string;
  outcome: AttestationRow['outcome'];
  decisiveM: number | null;
  created: boolean;
  published: boolean;
}

export async function attest(ctx: OracleCtx, siteId: string, date: string): Promise<AttestResult> {
  const site = requireSite(siteId);
  requireDate(date);
  const eventId = eventIdFor(site.id, date, ctx.replayRunId);
  const ann = getAnnouncement(ctx.db, eventId);
  if (!ann) throw new JobError('no_announcement', `${eventId} was not announced`);
  let created = false;
  let row = getAttestation(ctx.db, eventId);
  if (!row) {
    const now = ctx.clock();
    const { event: annEvent, content } = announcementContent(ann);
    if (now < new Date(content.attestAt)) {
      throw new JobError('too_early', `${eventId}: attestation is due at ${content.attestAt}`);
    }
    if (now >= new Date(content.window.end)) {
      throw new JobError('window_closed', `${eventId}: the window closed at ${content.window.end}`);
    }
    row = ctx.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(attestations)
        .where(eq(attestations.eventId, eventId))
        .get();
      if (existing) return existing;
      const current = tx
        .select()
        .from(announcements)
        .where(eq(announcements.eventId, eventId))
        .get();
      if (!current?.nonceEnc)
        throw new JobError('nonce_missing', `${eventId}: no nonce left; refusing to sign`);

      const rows = tx.select().from(forecasts).where(eq(forecasts.eventId, eventId)).all();
      const observations: ModelObservation[] = [];
      for (const id of content.rule.models) {
        const r = rows.find((x) => x.model === id && x.status === 'ok');
        if (r?.sha256) {
          observations.push({
            id,
            windowMaxM: r.windowMaxM,
            validHours: r.validHours,
            url: r.url,
            sha256: r.sha256,
          });
        }
      }
      const outcome = decideOutcome(
        {
          thresholdM: content.rule.thresholdM,
          minValidHours: content.rule.minValidHours,
          models: content.rule.models,
        },
        observations,
      );
      const maxima = observations.map((o) => o.windowMaxM);
      const decisiveM =
        maxima.length === content.rule.models.length && maxima.every((m): m is number => m !== null)
          ? Math.min(...maxima)
          : null;
      const fetchedAt = rows
        .filter((r) => r.status === 'ok')
        .map((r) => r.fetchedAt)
        .sort()
        .at(-1);

      const k = open(ctx.nonceKey, current.nonceEnc, eventId);
      const { event } = buildAttestation({
        secret: ctx.secret,
        announcement: annEvent,
        nonceK: k,
        outcome,
        data: { fetchedAt: fetchedAt ?? isoSeconds(now), models: observations },
        createdAt: unixSeconds(now),
      });
      // Self-check with the exact code the public verifier runs.
      const report = verifyAttestationEvent(annEvent, event, {
        expectedOraclePubkey: getPublicKey(ctx.secret),
      });
      if (!report.ok)
        throw new JobError('self_check_failed', report.error ?? 'verification failed');

      tx.insert(attestations)
        .values({
          eventId,
          site: site.id,
          date,
          replayRunId: ctx.replayRunId ?? null,
          outcome,
          decisiveM,
          nostrId: event.id,
          eventJson: JSON.stringify(event),
          createdAt: isoSeconds(new Date(event.created_at * 1000)),
        })
        .run();
      tx.update(announcements)
        .set({ nonceEnc: null })
        .where(eq(announcements.eventId, eventId))
        .run();
      created = true;
      return tx
        .select()
        .from(attestations)
        .where(eq(attestations.eventId, eventId))
        .get() as AttestationRow;
    });
    if (created)
      ctx.log.info('attestation signed', {
        eventId,
        outcome: row.outcome,
        decisiveM: row.decisiveM,
      });
  }
  // The commitment should reach relays before the attestation.
  await publishRow(ctx, 'announcement', eventId);
  const published = await publishRow(ctx, 'attestation', eventId);
  return {
    eventId,
    nostrId: row.nostrId,
    outcome: row.outcome,
    decisiveM: row.decisiveM,
    created,
    published,
  };
}

// ---------------------------------------------------------------------------
// retry publishing

/** Re-publishes this context's unpublished announcements and attestations (live or one replay run). */
export async function publishPending(ctx: OracleCtx): Promise<number> {
  if (!ctx.publisher) return 0;
  const now = new Date();
  const scope = (rid: string | null) =>
    ctx.replayRunId === undefined ? rid === null : rid === ctx.replayRunId;
  let published = 0;
  const anns = ctx.db.select().from(announcements).where(isNull(announcements.publishedAt)).all();
  for (const a of anns) {
    if (scope(a.replayRunId) && dueForRetry(a.publishResult, now)) {
      if (await publishRow(ctx, 'announcement', a.eventId)) published++;
    }
  }
  const atts = ctx.db.select().from(attestations).where(isNull(attestations.publishedAt)).all();
  for (const a of atts) {
    if (scope(a.replayRunId) && dueForRetry(a.publishResult, now)) {
      if (await publishRow(ctx, 'attestation', a.eventId)) published++;
    }
  }
  return published;
}
