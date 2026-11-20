/**
 * CLPA dashboard API (docs/BRIEF.md §9): everything under /api/admin needs a session; every
 * state-changing call also needs the CSRF token. Responses carry pseudonyms and masked hints,
 * never a phone number or a Lightning address.
 */
import { getSite, SITE_IDS } from '@ndox/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { collectAlerts } from '../admin/alerts.js';
import { cmToM, mToCm } from '../db/index.js';
import { crews, deposits, payouts, policies, sites } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import {
  derivedAdminPassword,
  equalStrings,
  PasswordHashError,
  verifyPassword,
} from '../lib/password.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { isoSeconds } from '../lib/time.js';
import { JobError } from '../oracle/jobs.js';
import { runReplay } from '../oracle/replay.js';
import { processPayout } from '../payouts/engine.js';
import { payReplay } from '../payouts/replay.js';
import { CrewInputError, crewView, enrolCrew } from '../pool/crews.js';
import {
  createDeposit,
  DepositError,
  refreshDeposit,
  weeklyPremiumFor,
  type DepositRow,
} from '../pool/deposits.js';
import { createPolicy, PolicyError, policyStatusAt, type PolicyRow } from '../pool/policies.js';
import { PolicySettingsPatch, updatePolicySettings } from '../pool/settings.js';
import { poolSnapshot } from '../pool/stats.js';
import { demoPayMode, payDemoDeposit } from '../pool/demopay.js';
import type { Services } from '../services.js';
import {
  originAllowed,
  readSessionCookie,
  SessionStore,
  type AdminSession,
} from './admin-session.js';
import { limit } from './money.js';

const ID = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-f]{12}$`));
const SiteId = z.string().refine((v) => (SITE_IDS as readonly string[]).includes(v));
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HashParam = z.object({ paymentHash: z.string().regex(/^[0-9a-f]{64}$/) });

const LoginBody = z.object({ password: z.string().min(1).max(200) }).strict();
const CrewBody = z
  .object({
    site: SiteId,
    lnAddress: z.string().trim().min(3).max(320),
    phone: z.string().trim().max(32).optional(),
    pseudonym: z.string().trim().max(40).optional(),
    demo: z.boolean().optional(),
  })
  .strict();
const CrewPatch = z.object({ active: z.boolean() }).strict();
const PolicyBody = z
  .object({
    crewId: ID('c'),
    weeks: z.number().int().min(1).max(52).default(1),
    fundedBy: z.enum(['crew', 'clpa', 'sponsor']).default('crew'),
    /** Also issue the premium invoice now. */
    invoice: z.boolean().default(true),
  })
  .strict();
const DepositBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('levy'), amountFcfa: z.number().int() }).strict(),
  z.object({ kind: z.literal('premium'), policyId: ID('p') }).strict(),
]);
const ReplayBody = z
  .object({ site: SiteId, date: DateStr, pay: z.boolean().default(true) })
  .strict();
const SettingsBody = z
  .object({
    policy: PolicySettingsPatch.optional(),
    sites: z
      .array(
        z
          .object({
            id: SiteId,
            thresholdM: z.number().min(1).max(6).optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      )
      .max(SITE_IDS.length)
      .optional(),
  })
  .strict();
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['pending', 'paying', 'paid', 'failed']).optional(),
});

declare module 'fastify' {
  interface FastifyRequest {
    adminSession?: AdminSession;
  }
}

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'bad_request' });

export function registerAdminRoutes(app: FastifyInstance, s: Services): void {
  const { db, config } = s;
  const ctx = s.money;
  const store = new SessionStore({
    sessionSecret: config.secrets.session,
    secure: config.publicBaseUrl.startsWith('https://'),
  });
  const allowLocalhost = config.env !== 'production';
  const loginLimiter = new RateLimiter(5, 15 * 60_000);
  const loginGlobal = new RateLimiter(100, 15 * 60_000);
  const fakePassword =
    !config.adminPasswordHash && config.walletMode === 'fake'
      ? derivedAdminPassword(config.secrets.session)
      : undefined;
  let replayRunning = false;

  async function passwordOk(password: string): Promise<boolean> {
    if (config.adminPasswordHash) {
      try {
        return await verifyPassword(password, config.adminPasswordHash);
      } catch (err) {
        if (err instanceof PasswordHashError) s.log.error('admin password hash invalid');
        else throw err;
        return false;
      }
    }
    return fakePassword !== undefined && equalStrings(password, fakePassword);
  }

  const now = () => s.clock();
  const policyView = (p: PolicyRow) => ({
    id: p.id,
    crewId: p.crewId,
    site: p.site,
    state: policyStatusAt(p, now()),
    payoutFcfa: p.payoutFcfa,
    thresholdM: cmToM(p.thresholdCm),
    premiumFcfa: p.premiumFcfa,
    weeks: p.weeks,
    fundedBy: p.fundedBy,
    paidAt: p.paidAt,
    activeFrom: p.activeFrom,
    activeUntil: p.activeUntil,
    demo: p.demo,
    nostrId: p.eventJson ? (JSON.parse(p.eventJson) as { id: string }).id : null,
    publishedAt: p.publishedAt,
    createdAt: p.createdAt,
  });
  const depositView = (d: DepositRow) => ({
    id: d.id,
    kind: d.kind,
    status: d.status,
    amountSat: d.amountSat,
    amountFcfa: d.amountFcfa,
    xofPerBtc: d.xofPerBtc,
    paymentHash: d.paymentHash,
    invoice: d.status === 'pending' ? d.invoice : null,
    policyId: d.policyId,
    crew: d.crewId
      ? (db.select({ p: crews.pseudonym }).from(crews).where(eq(crews.id, d.crewId)).get()?.p ??
        null)
      : null,
    site: d.site,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    paidAt: d.paidAt,
    simulated: d.wallet === 'fake',
    testFunds: d.wallet === 'nwc' && ctx.testFunds === true,
  });
  const latestPolicy = (crewId: string) =>
    db
      .select()
      .from(policies)
      .where(eq(policies.crewId, crewId))
      .orderBy(desc(policies.createdAt), desc(policies.id))
      .get();

  // what the dashboard needs to label money and offer the demo "pay" button
  const walletInfo = {
    kind: s.wallet.kind,
    simulated: s.wallet.simulated,
    testFunds: ctx.testFunds === true,
    demoPay: demoPayMode(ctx),
    network: config.network,
  };

  const moneyError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DepositError || err instanceof PolicyError)
      return reply.code(400).send({ error: err.code });
    s.log.error('admin money call failed', { error: errorMessage(err) });
    return reply.code(503).send({ error: 'wallet_unavailable' });
  };

  app.register(
    async (admin) => {
      admin.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header('cache-control', 'no-store');
        const mutating = req.method !== 'GET' && req.method !== 'HEAD';
        if (mutating && !originAllowed(req, config.publicBaseUrl, allowLocalhost))
          return reply.code(403).send({ error: 'forbidden' });
        if (req.routeOptions.url === '/api/admin/login') return;
        const session = store.get(readSessionCookie(req));
        if (!session) return reply.code(401).send({ error: 'unauthorized' });
        if (mutating && !store.checkCsrf(session, req.headers['x-csrf-token']))
          return reply.code(403).send({ error: 'csrf' });
        req.adminSession = session;
      });

      admin.post('/login', async (req, reply) => {
        if (limit(loginGlobal, 'all', req, reply)) return reply;
        if (limit(loginLimiter, 'login', req, reply)) return reply;
        const b = LoginBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        if (!(await passwordOk(b.data.password))) {
          s.log.warn('admin login failed');
          return reply.code(401).send({ error: 'invalid_credentials' });
        }
        loginLimiter.reset(`login:${req.ip}`);
        const session = store.create();
        store.setCookie(reply, session);
        s.log.info('admin login');
        return {
          csrfToken: session.csrfToken,
          expiresAt: isoSeconds(new Date(session.expiresAt)),
        };
      });

      admin.post('/logout', async (req, reply) => {
        store.destroy(req.adminSession?.id);
        store.clearCookie(reply);
        return reply.code(204).send();
      });

      admin.get('/session', async (req) => ({
        csrfToken: req.adminSession!.csrfToken,
        expiresAt: isoSeconds(new Date(req.adminSession!.expiresAt)),
        wallet: walletInfo,
      }));

      // ── crews ────────────────────────────────────────────────────────────────────────────
      admin.get('/crews', async () => ({
        items: db
          .select()
          .from(crews)
          .orderBy(crews.site, crews.pseudonym)
          .all()
          .map((c) => {
            const p = latestPolicy(c.id);
            return { ...crewView(c, s.piiKey), policy: p ? policyView(p) : null };
          }),
      }));

      admin.post('/crews', async (req, reply) => {
        const b = CrewBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        try {
          const crew = enrolCrew(db, s.piiKey, {
            site: b.data.site,
            lnAddress: b.data.lnAddress,
            phone: b.data.phone,
            pseudonym: b.data.pseudonym,
            // a crew enrolled next to a simulated wallet can only ever be paid in simulation
            demo: b.data.demo ?? s.wallet.simulated,
          });
          s.log.info('admin: crew enrolled', { crew: crew.id, site: crew.site, demo: crew.demo });
          return reply.code(201).send({ ...crew, policy: null });
        } catch (err) {
          if (err instanceof CrewInputError)
            return reply.code(400).send({ error: 'invalid', message: err.message });
          throw err;
        }
      });

      admin.patch('/crews/:id', async (req, reply) => {
        const id = ID('c').safeParse((req.params as { id?: unknown }).id);
        const b = CrewPatch.safeParse(req.body);
        if (!id.success || !b.success) return bad(reply);
        const row = db
          .update(crews)
          .set({ active: b.data.active })
          .where(eq(crews.id, id.data))
          .returning()
          .get();
        if (!row) return reply.code(404).send({ error: 'not_found' });
        s.log.info('admin: crew updated', { crew: row.id, active: row.active });
        const p = latestPolicy(row.id);
        return { ...crewView(row, s.piiKey), policy: p ? policyView(p) : null };
      });

      // ── policies and deposits ────────────────────────────────────────────────────────────
      admin.get('/policies', async () => ({
        items: db
          .select({ p: policies, pseudonym: crews.pseudonym })
          .from(policies)
          .innerJoin(crews, eq(crews.id, policies.crewId))
          .orderBy(desc(policies.createdAt))
          .limit(500)
          .all()
          .map(({ p, pseudonym }) => ({ ...policyView(p), crew: pseudonym })),
      }));

      admin.post('/policies', async (req, reply) => {
        const b = PolicyBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        let policy: PolicyRow;
        try {
          const crew = db.select().from(crews).where(eq(crews.id, b.data.crewId)).get();
          if (!crew) return reply.code(400).send({ error: 'unknown_crew' });
          policy = createPolicy(db, {
            crewId: crew.id,
            fundedBy: b.data.fundedBy,
            weeks: b.data.weeks,
            payoutFcfa: s.settings().payoutFcfa,
            premiumWeeklyFcfa: weeklyPremiumFor(ctx, db, crew.site),
          });
        } catch (err) {
          return moneyError(reply, err);
        }
        s.log.info('admin: policy created', { policy: policy.id, weeks: policy.weeks });
        let deposit: ReturnType<typeof depositView> | null = null;
        if (b.data.invoice) {
          try {
            deposit = depositView(
              await createDeposit(ctx, { kind: 'premium', policyId: policy.id }),
            );
          } catch (err) {
            s.log.warn('premium invoice failed', { error: errorMessage(err) });
          }
        }
        return reply.code(201).send({ policy: policyView(policy), deposit });
      });

      admin.get('/deposits', async (req, reply) => {
        const q = ListQuery.omit({ status: true }).safeParse(req.query);
        if (!q.success) return bad(reply);
        return {
          items: db
            .select()
            .from(deposits)
            .orderBy(desc(deposits.createdAt), deposits.id)
            .limit(q.data.limit)
            .all()
            .map(depositView),
        };
      });

      admin.post('/deposits', async (req, reply) => {
        const b = DepositBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        try {
          const d = await createDeposit(ctx, b.data);
          s.log.info('admin: deposit invoice', { deposit: d.id, kind: d.kind, sat: d.amountSat });
          return reply.code(201).send(depositView(d));
        } catch (err) {
          return moneyError(reply, err);
        }
      });

      const findDeposit = (hash: string) =>
        db.select().from(deposits).where(eq(deposits.paymentHash, hash)).get();

      admin.get('/deposits/:paymentHash', async (req, reply) => {
        const p = HashParam.safeParse(req.params);
        if (!p.success) return bad(reply);
        if (!findDeposit(p.data.paymentHash)) return reply.code(404).send({ error: 'not_found' });
        try {
          await refreshDeposit(ctx, p.data.paymentHash);
        } catch (err) {
          s.log.warn('deposit lookup failed', { error: errorMessage(err) });
        }
        return depositView(findDeposit(p.data.paymentHash)!);
      });

      if (demoPayMode(ctx)) {
        admin.post('/deposits/:paymentHash/simulate', async (req, reply) => {
          const p = HashParam.safeParse(req.params);
          if (!p.success) return bad(reply);
          const d = findDeposit(p.data.paymentHash);
          if (!d) return reply.code(404).send({ error: 'not_found' });
          const r = await payDemoDeposit(ctx, d);
          if (r === 'not_payable') return reply.code(409).send({ error: 'not_payable' });
          if (r === 'failed') return reply.code(502).send({ error: 'test_payment_failed' });
          return depositView(findDeposit(p.data.paymentHash)!);
        });
      }

      // ── payouts and alerts ───────────────────────────────────────────────────────────────
      admin.get('/payouts', async (req, reply) => {
        const q = ListQuery.safeParse(req.query);
        if (!q.success) return bad(reply);
        return {
          items: db
            .select({ p: payouts, pseudonym: crews.pseudonym })
            .from(payouts)
            .innerJoin(policies, eq(policies.id, payouts.policyId))
            .innerJoin(crews, eq(crews.id, policies.crewId))
            .where(
              and(
                eq(payouts.replay, false),
                q.data.status ? eq(payouts.status, q.data.status) : undefined,
              ),
            )
            .orderBy(desc(payouts.createdAt), payouts.id)
            .limit(q.data.limit)
            .all()
            .map(({ p, pseudonym }) => ({
              id: p.id,
              crew: pseudonym,
              site: p.site,
              attestationId: p.attestationId,
              amountSat: p.amountSat,
              dueSat: p.dueSat,
              amountFcfa: p.amountFcfa,
              factorPpm: p.factorPpm,
              status: p.status,
              attempts: p.attempts,
              nextAttemptAt: p.nextAttemptAt,
              error: p.error,
              paymentHash: p.paymentHash,
              paidAt: p.paidAt,
              simulated: p.wallet === 'fake',
              testFunds: p.wallet === 'nwc' && ctx.testFunds === true,
              createdAt: p.createdAt,
            })),
        };
      });

      // A failed payout goes back to the state machine, which looks its stored invoice up
      // before anything else: a retry can never pay twice.
      admin.post('/payouts/:id/retry', async (req, reply) => {
        const id = z
          .string()
          .regex(/^x[0-9a-f]{12}$/)
          .safeParse((req.params as { id?: unknown }).id);
        if (!id.success) return bad(reply);
        const res = db
          .update(payouts)
          .set({
            status: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            updatedAt: isoSeconds(now()),
          })
          .where(
            and(
              eq(payouts.id, id.data),
              eq(payouts.status, 'failed'),
              eq(payouts.replay, false),
              eq(payouts.wallet, s.wallet.kind),
            ),
          )
          .run();
        if (res.changes !== 1) return reply.code(409).send({ error: 'not_retryable' });
        s.log.info('admin: payout retry', { payout: id.data });
        const step = await processPayout(ctx, id.data).catch((err: unknown) => {
          s.log.warn('payout retry step failed', { payout: id.data, error: errorMessage(err) });
          return 'retry' as const;
        });
        const row = db.select().from(payouts).where(eq(payouts.id, id.data)).get()!;
        return { id: row.id, step, status: row.status, attempts: row.attempts };
      });

      admin.get('/alerts', async () => {
        const pool = await poolSnapshot(ctx, config.network);
        return { alerts: collectAlerts(s, pool) };
      });

      // ── replay ───────────────────────────────────────────────────────────────────────────
      admin.post('/replay', async (req, reply) => {
        const b = ReplayBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        if (replayRunning) return reply.code(409).send({ error: 'replay_running' });
        replayRunning = true;
        try {
          const r = await runReplay(s.replay, b.data.site, b.data.date);
          const pay =
            b.data.pay && r.outcome === 'danger' && r.verification.ok
              ? await payReplay(ctx, r, s.replayPayouts)
              : null;
          s.log.info('admin: replay', { run: r.runId, site: r.site, date: r.date });
          return { replay: r, payouts: pay };
        } catch (err) {
          if (err instanceof JobError) return reply.code(400).send({ error: err.code });
          s.log.error('replay failed', { error: errorMessage(err) });
          return reply.code(502).send({ error: 'replay_failed' });
        } finally {
          replayRunning = false;
        }
      });

      // ── settings ─────────────────────────────────────────────────────────────────────────
      const settingsView = () => ({
        policy: s.settings(),
        defaults: s.policyDefaults,
        sites: db
          .select()
          .from(sites)
          .all()
          .map((r) => ({
            id: r.id,
            name: getSite(r.id)?.name ?? r.id,
            thresholdM: cmToM(r.thresholdCm),
            enabled: r.enabled,
            updatedAt: r.updatedAt,
          })),
        wallet: walletInfo,
      });

      admin.get('/settings', async () => settingsView());

      admin.put('/settings', async (req, reply) => {
        const b = SettingsBody.safeParse(req.body);
        if (!b.success) return bad(reply);
        db.transaction((tx) => {
          if (b.data.policy) updatePolicySettings(tx, s.policyDefaults, b.data.policy);
          for (const site of b.data.sites ?? []) {
            tx.update(sites)
              .set({
                ...(site.thresholdM !== undefined ? { thresholdCm: mToCm(site.thresholdM) } : {}),
                ...(site.enabled !== undefined ? { enabled: site.enabled } : {}),
                updatedAt: isoSeconds(now()),
              })
              .where(eq(sites.id, site.id))
              .run();
          }
        });
        s.log.info('admin: settings updated', {
          policy: Object.keys(b.data.policy ?? {}).join(','),
          sites: (b.data.sites ?? []).map((x) => x.id).join(','),
        });
        return settingsView();
      });
    },
    { prefix: '/api/admin' },
  );
}
