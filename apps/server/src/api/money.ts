/**
 * Public money API (docs/BRIEF.md §9): pool picture, payout proofs, sponsor invoices.
 * No personal data: crews appear by public pseudonym only when a sponsor names one.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attestations, crews, deposits, payouts, policies } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { DepositError, createDeposit, refreshDeposit, weeklyPremiumFor } from '../pool/deposits.js';
import { poolSnapshot, type PoolSnapshot } from '../pool/stats.js';
import type { Services } from '../services.js';
import { FakeWallet } from '../wallet/fake.js';

const HASH = /^[0-9a-f]{64}$/;
const SponsorBody = z
  .object({
    amountFcfa: z.number().int().min(100).max(5_000_000),
    site: z
      .string()
      .regex(/^[a-z-]{2,30}$/)
      .optional(),
    crewPseudonym: z.string().trim().min(3).max(40).optional(),
  })
  .strict();
const HashParam = z.object({ paymentHash: z.string().regex(HASH) });
const PayoutsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  site: z
    .string()
    .regex(/^[a-z-]{2,30}$/)
    .optional(),
});

export function limit(
  limiter: RateLimiter,
  name: string,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const wait = limiter.take(`${name}:${req.ip}`);
  if (wait === 0) return false;
  void reply.code(429).header('retry-after', String(wait)).send({ error: 'rate_limited' });
  return true;
}

export function registerMoneyRoutes(app: FastifyInstance, s: Services): void {
  const { db } = s;
  const ctx = s.money;
  const invoiceLimiter = new RateLimiter(10, 10 * 60_000);
  const lookupLimiter = new RateLimiter(120, 60_000);
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  let cached: { at: number; body: PoolSnapshot } | null = null;
  app.get('/api/pool', async (_req, reply) => {
    const t = Date.now();
    if (!cached || t - cached.at > 10_000) {
      cached = { at: t, body: await poolSnapshot(ctx, s.config.network) };
    }
    noStore(reply);
    return cached.body;
  });

  app.get('/api/payouts', async (req, reply) => {
    const q = PayoutsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const rows = db
      .select({ p: payouts, date: attestations.date, nostrId: attestations.nostrId })
      .from(payouts)
      .innerJoin(attestations, eq(attestations.eventId, payouts.attestationId))
      .where(
        and(eq(payouts.replay, false), q.data.site ? eq(payouts.site, q.data.site) : undefined),
      )
      .orderBy(desc(payouts.createdAt), payouts.id)
      .limit(q.data.limit)
      .all();
    noStore(reply);
    return {
      items: rows.map(({ p, date, nostrId }) => ({
        id: p.id,
        site: p.site,
        date,
        attestationId: p.attestationId,
        attestationNostrId: nostrId,
        policyId: p.policyId,
        amountFcfa: p.amountFcfa,
        dueSat: p.dueSat,
        amountSat: p.amountSat,
        factorPpm: p.factorPpm,
        status: p.status,
        paymentHash: p.status === 'paid' ? p.paymentHash : null,
        preimage: p.status === 'paid' ? p.preimage : null,
        paidAt: p.paidAt,
        simulated: p.wallet === 'fake',
        receiptNostrId: p.receiptJson ? (JSON.parse(p.receiptJson) as { id: string }).id : null,
        receiptPublishedAt: p.receiptPublishedAt,
      })),
    };
  });

  const sponsorView = (d: typeof deposits.$inferSelect) => {
    const crew = d.crewId
      ? db.select({ pseudonym: crews.pseudonym }).from(crews).where(eq(crews.id, d.crewId)).get()
      : undefined;
    const policy = d.policyId
      ? db
          .select({ activeFrom: policies.activeFrom, activeUntil: policies.activeUntil })
          .from(policies)
          .where(eq(policies.id, d.policyId))
          .get()
      : undefined;
    return {
      paymentHash: d.paymentHash,
      status: d.status,
      amountSat: d.amountSat,
      amountFcfa: d.amountFcfa,
      xofPerBtc: d.xofPerBtc,
      site: d.site,
      crew: crew?.pseudonym ?? null,
      cover: d.status === 'paid' && policy ? policy : null,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      paidAt: d.paidAt,
      simulated: d.wallet === 'fake',
    };
  };

  // Demo crews a sponsor can pick on /soutenir. Only demo crews are listed: a real crew's
  // pseudonym is shared by the crew itself, never published by Ndox.
  app.get('/api/sponsor/crews', async (_req, reply) => {
    noStore(reply);
    return {
      items: db
        .select({ pseudonym: crews.pseudonym, site: crews.site })
        .from(crews)
        .where(and(eq(crews.demo, true), eq(crews.active, true)))
        .orderBy(crews.site, crews.pseudonym)
        .limit(200)
        .all(),
    };
  });

  const sponsorDeposit = (paymentHash: string) =>
    db
      .select()
      .from(deposits)
      .where(and(eq(deposits.paymentHash, paymentHash), eq(deposits.kind, 'sponsor')))
      .get();

  app.post('/api/sponsor/invoice', async (req, reply) => {
    if (limit(invoiceLimiter, 'sponsor', req, reply)) return reply;
    const b = SponsorBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const d = await createDeposit(ctx, {
        kind: 'sponsor',
        amountFcfa: b.data.amountFcfa,
        ...(b.data.site ? { site: b.data.site } : {}),
        ...(b.data.crewPseudonym ? { crewPseudonym: b.data.crewPseudonym } : {}),
      });
      let weeks: number | null = null;
      if (d.crewId && d.site) {
        const weekly = weeklyPremiumFor(ctx, db, d.site);
        weeks = weekly > 0 ? Math.min(52, Math.floor(b.data.amountFcfa / weekly)) : 0;
      }
      noStore(reply);
      return reply.code(201).send({ ...sponsorView(d), invoice: d.invoice, coverWeeks: weeks });
    } catch (err) {
      if (err instanceof DepositError) return reply.code(400).send({ error: err.code });
      s.log.error('sponsor invoice failed', { error: errorMessage(err) });
      return reply.code(503).send({ error: 'wallet_unavailable' });
    }
  });

  app.get('/api/sponsor/invoice/:paymentHash', async (req, reply) => {
    if (limit(lookupLimiter, 'sponsor-get', req, reply)) return reply;
    const p = HashParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!sponsorDeposit(p.data.paymentHash)) return reply.code(404).send({ error: 'not_found' });
    try {
      await refreshDeposit(ctx, p.data.paymentHash);
    } catch (err) {
      s.log.warn('deposit lookup failed', { error: errorMessage(err) });
    }
    noStore(reply);
    return sponsorView(sponsorDeposit(p.data.paymentHash)!);
  });

  // Demo only (WALLET_MODE=fake): "Simuler le paiement". Absent with a real wallet.
  if (ctx.wallet instanceof FakeWallet) {
    const wallet = ctx.wallet;
    app.post('/api/sponsor/invoice/:paymentHash/simulate', async (req, reply) => {
      if (limit(invoiceLimiter, 'sponsor-sim', req, reply)) return reply;
      const p = HashParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      const d = sponsorDeposit(p.data.paymentHash);
      if (!d) return reply.code(404).send({ error: 'not_found' });
      if (d.status === 'pending' && !wallet.simulatePayment(p.data.paymentHash))
        return reply.code(409).send({ error: 'not_payable' });
      await refreshDeposit(ctx, p.data.paymentHash);
      cached = null;
      noStore(reply);
      return sponsorView(sponsorDeposit(p.data.paymentHash)!);
    });
  }
}
