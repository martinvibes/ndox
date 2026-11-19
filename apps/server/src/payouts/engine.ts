/**
 * Payout engine (docs/BRIEF.md §7.3). The arithmetic is the pure planPayouts() in @ndox/shared;
 * this module is the I/O shell around it.
 *
 *  plan   once per attestation, in one transaction: verify the attestation with the public
 *         verifier's code → outcome → covered policies → price, balance, reserve, daily cap →
 *         a payout_runs row (the frozen plan) + one payout row per policy, UNIQUE(policy, attestation).
 *  pay    every payout, each tick until done: pending → paying → paid | failed. The crew's invoice
 *         is stored before payInvoice is called. Every later step looks the stored invoice up first:
 *         settled → paid; in flight → wait; otherwise re-send the same invoice (one payment hash
 *         can only be paid once) and only ask for a new invoice once the stored one has expired.
 *  publish  receipts (kind 30078, d = ndox:payout:<policyId>:<attestationId>) and a run summary
 *         (d = ndox:payout-run:<attestationId>), signed by POOL_SECRET, without personal data.
 */
import {
  finalizeEvent,
  verifyAttestationEvent,
  type NostrEvent,
  type VerificationReport,
} from '@ndox/oracle';
import { addDays, getSite, planPayouts } from '@ndox/shared';
import { and, eq, gte, inArray, isNull, lt, lte, ne, or, sum, type SQL } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { attestations, payoutRuns, payouts, policies } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { isoDate, isoSeconds, unixSeconds } from '../lib/time.js';
import { dueForRetry } from '../nostr/publisher.js';
import { getAnnouncement, getAttestation } from '../oracle/jobs.js';
import { crewSecrets } from '../pool/crews.js';
import { pollDeposits, type MoneyCtx } from '../pool/deposits.js';
import {
  eligiblePolicies,
  expirePolicies,
  KIND_APP_DATA,
  publishPendingPolicies,
  type DbLike,
} from '../pool/policies.js';
import { preimageMatches } from '../wallet/nwc.js';
import type { LnAddressResolver } from '../wallet/types.js';

export const MAX_ATTEMPTS = 5;
/** Backoff after attempt n: 60 s × 2^(n−1). */
export const BACKOFF_BASE_MS = 60_000;
/** How often an in-flight payment is looked up again. */
export const IN_FLIGHT_RECHECK_MS = 60_000;
/** Live attestations older than this are never planned automatically (e.g. after a long outage). */
export const PLAN_LOOKBACK_DAYS = 7;

export interface PayoutCtx extends MoneyCtx {
  piiKey: Buffer;
  resolver: LnAddressResolver;
  /** Key the attestation must be signed by (ORACLE_SECRET live, DEMO_ORACLE_SECRET in a replay). */
  oraclePubkey: string;
  /**
   * Replay context: pays only that run's attestation, only demo crews covered at `coverAt` (the
   * real time), from a simulated wallet, and never publishes.
   */
  replay?: { runId: string; coverAt: Date };
}

export type PayoutRunRow = typeof payoutRuns.$inferSelect;
export type PayoutRow = typeof payouts.$inferSelect;
export type StepResult = 'paid' | 'retry' | 'waiting' | 'failed' | 'skipped';

export class PayoutError extends Error {
  constructor(
    readonly code: 'unknown_attestation' | 'wrong_context',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

export function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

/** Errors are stored and shown on the dashboard: keep invoices and addresses out of them. */
export function scrubError(message: string): string {
  return message
    .replace(/\bln(?:bcrt|bc|tbs|tb)[0-9a-z]{6,}/gi, '[invoice]')
    .replace(/[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, '[address]')
    .slice(0, 300);
}

export function getPayoutRun(db: DbLike, attestationId: string): PayoutRunRow | undefined {
  return db.select().from(payoutRuns).where(eq(payoutRuns.attestationId, attestationId)).get();
}

function getPayout(db: DbLike, id: string): PayoutRow | undefined {
  return db.select().from(payouts).where(eq(payouts.id, id)).get();
}

function sumSat(db: DbLike, where: SQL | undefined): number {
  const r = db
    .select({ s: sum(payouts.amountSat) })
    .from(payouts)
    .where(where)
    .get();
  return Number(r?.s ?? 0);
}

function summarize(report: VerificationReport) {
  return {
    ok: report.ok,
    checks: report.checks.map((c) => ({ id: c.id, ok: c.ok })),
    ...(report.error ? { error: report.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// plan

export async function planPayoutRun(ctx: PayoutCtx, attestationId: string): Promise<PayoutRunRow> {
  const existing = getPayoutRun(ctx.db, attestationId);
  if (existing) return existing;
  const att = getAttestation(ctx.db, attestationId);
  const ann = getAnnouncement(ctx.db, attestationId);
  if (!att || !ann) throw new PayoutError('unknown_attestation', `no attestation ${attestationId}`);
  const replay = att.replayRunId !== null;
  if (replay && ctx.replay?.runId !== att.replayRunId)
    throw new PayoutError('wrong_context', 'a replay attestation never pays from the live pool');
  if (!replay && ctx.replay)
    throw new PayoutError('wrong_context', 'a replay pays only its own attestation');

  const now = ctx.clock();
  const base = {
    attestationId,
    site: att.site,
    date: att.date,
    outcome: att.outcome,
    replay,
    wallet: ctx.wallet.kind,
    createdAt: isoSeconds(now),
  };
  const record = (values: typeof payoutRuns.$inferInsert): PayoutRunRow => {
    ctx.db.insert(payoutRuns).values(values).onConflictDoNothing().run();
    return getPayoutRun(ctx.db, attestationId)!;
  };

  let report: VerificationReport;
  try {
    report = verifyAttestationEvent(
      JSON.parse(ann.eventJson) as NostrEvent,
      JSON.parse(att.eventJson) as NostrEvent,
      { expectedOraclePubkey: ctx.oraclePubkey },
    );
  } catch (err) {
    report = { ok: false, checks: [], error: errorMessage(err) };
  }
  const verification = summarize(report);
  const matches =
    report.ok &&
    report.outcome === att.outcome &&
    report.announcement?.eventId === attestationId &&
    report.announcement.site === att.site;
  if (!matches) {
    const detail = !report.ok
      ? (report.error ?? 'verification failed')
      : 'stored row does not match the signed attestation';
    ctx.log.error('payout refused: attestation failed verification', { attestationId, detail });
    return record({ ...base, status: 'invalid', verification, detail });
  }
  if (report.outcome !== 'danger')
    return record({
      ...base,
      status: 'no_payout',
      verification,
      detail: `outcome ${report.outcome}`,
    });

  const windowStart = new Date(report.announcement!.window.start);
  const coverAt = ctx.replay?.coverAt ?? windowStart;
  const covered = eligiblePolicies(ctx.db, att.site, coverAt, { demoOnly: replay });
  if (covered.length === 0)
    return record({ ...base, status: 'no_payout', verification, detail: 'no covered policy' });

  const price = await ctx.prices.get();
  const balanceSat = await ctx.wallet.getBalanceSat();
  const s = ctx.settings();
  const kind = ctx.wallet.kind;
  return ctx.db.transaction(
    (tx) => {
      const again = getPayoutRun(tx, attestationId);
      if (again) return again;
      // A replay wallet is new for each run: nothing outstanding, nothing paid today.
      const live = and(eq(payouts.replay, false), eq(payouts.wallet, kind));
      const outstandingSat = replay
        ? 0
        : sumSat(tx, and(live, inArray(payouts.status, ['pending', 'paying'])));
      const today = isoDate(now);
      const paidTodaySat = replay
        ? 0
        : sumSat(
            tx,
            and(
              live,
              ne(payouts.status, 'failed'),
              gte(payouts.createdAt, `${today}T00:00:00Z`),
              lt(payouts.createdAt, `${addDays(today, 1)}T00:00:00Z`),
            ),
          );
      const plan = planPayouts({
        policies: covered.map((p) => ({ policyId: p.id, payoutFcfa: p.payoutFcfa })),
        xofPerBtc: price.xofPerBtc,
        balanceSat: Math.max(0, balanceSat - outstandingSat),
        reserveFloorSat: s.reserveFloorSats,
        dailyCapSat: s.dailyPayoutCapSats,
        paidTodaySat,
      });
      tx.insert(payoutRuns)
        .values({
          ...base,
          status: 'planned',
          policies: covered.length,
          xofPerBtc: price.xofPerBtc,
          priceAsOf: price.asOf,
          priceStale: price.stale,
          balanceSat,
          outstandingSat,
          reserveFloorSat: s.reserveFloorSats,
          dailyCapSat: s.dailyPayoutCapSats,
          paidTodaySat,
          dueSat: plan.dueSat,
          availableSat: plan.availableSat,
          planSat: plan.paySat,
          shortfallSat: plan.shortfallSat,
          factorPpm: plan.factorPpm,
          limitedBy: plan.limitedBy,
          verification,
        })
        .run();
      const at = isoSeconds(now);
      for (const item of plan.items) {
        if (item.amountSat < 1) continue; // nothing payable after the pro-rata cut
        tx.insert(payouts)
          .values({
            id: `x${randomBytes(6).toString('hex')}`,
            policyId: item.policyId,
            attestationId,
            site: att.site,
            amountFcfa: item.amountFcfa,
            dueSat: item.dueSat,
            amountSat: item.amountSat,
            xofPerBtc: price.xofPerBtc,
            factorPpm: plan.factorPpm,
            status: 'pending',
            nextAttemptAt: at,
            wallet: kind,
            replay,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoNothing()
          .run();
      }
      if (plan.shortfallSat > 0)
        ctx.log.warn('payouts reduced pro rata', {
          attestationId,
          limitedBy: plan.limitedBy,
          factorPpm: plan.factorPpm,
        });
      return getPayoutRun(tx, attestationId)!;
    },
    { behavior: 'immediate' },
  );
}

// ---------------------------------------------------------------------------
// pay

/** Conditional write: applies only if nobody else moved the payout since `row` was read. */
function claim(ctx: PayoutCtx, row: PayoutRow, set: Partial<typeof payouts.$inferInsert>): boolean {
  return (
    ctx.db
      .update(payouts)
      .set({ ...set, updatedAt: isoSeconds(ctx.clock()) })
      .where(
        and(
          eq(payouts.id, row.id),
          eq(payouts.attempts, row.attempts),
          inArray(payouts.status, ['pending', 'paying']),
        ),
      )
      .run().changes === 1
  );
}

function markPaid(
  ctx: PayoutCtx,
  row: PayoutRow,
  preimage: string,
  feeSat: number | null,
): StepResult {
  const at = isoSeconds(ctx.clock());
  const res = ctx.db
    .update(payouts)
    .set({
      status: 'paid',
      preimage: preimage.toLowerCase(),
      feeSat,
      paidAt: at,
      error: null,
      nextAttemptAt: null,
      updatedAt: at,
    })
    .where(and(eq(payouts.id, row.id), inArray(payouts.status, ['pending', 'paying'])))
    .run();
  if (res.changes !== 1) return 'skipped';
  ctx.log.info('payout paid', { payout: row.id, sat: row.amountSat });
  return 'paid';
}

function giveUp(
  ctx: PayoutCtx,
  row: PayoutRow,
  error: string,
  attempts = row.attempts,
): StepResult {
  if (!claim(ctx, row, { status: 'failed', attempts, error, nextAttemptAt: null }))
    return 'skipped';
  ctx.log.error('payout failed: needs the council', { payout: row.id, attempts, error });
  return 'failed';
}

function crewAddress(ctx: PayoutCtx, policyId: string): string | null {
  const p = ctx.db.select().from(policies).where(eq(policies.id, policyId)).get();
  return p ? crewSecrets(ctx.db, ctx.piiKey, p.crewId).lnAddress : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** One step of the state machine for one payout. Safe to call any number of times. */
export async function processPayout(ctx: PayoutCtx, payoutId: string): Promise<StepResult> {
  const row = getPayout(ctx.db, payoutId);
  if (!row || row.status === 'paid' || row.status === 'failed') return 'skipped';
  // never pay a simulated payout from a real wallet, or a replay from the pool (or the reverse)
  if (row.wallet !== ctx.wallet.kind || row.replay !== (ctx.replay !== undefined)) return 'skipped';
  const now = ctx.clock();
  if (row.nextAttemptAt && now < new Date(row.nextAttemptAt)) return 'waiting';

  let invoice = row.invoice;
  let paymentHash = row.paymentHash;
  let expiresAt = row.invoiceExpiresAt;
  if (invoice && paymentHash) {
    const look = await ctx.wallet.lookupInvoice(paymentHash);
    if (look.state === 'settled' && look.preimage && preimageMatches(look.preimage, paymentHash))
      return markPaid(ctx, row, look.preimage, null);
    if (look.state === 'pending' || look.state === 'settled') {
      // in flight (or settled without a usable preimage yet): never send again, look again later
      claim(ctx, row, {
        nextAttemptAt: isoSeconds(new Date(now.getTime() + IN_FLIGHT_RECHECK_MS)),
      });
      return 'waiting';
    }
    // failed or unknown to the wallet: we did not pay it
    if (row.attempts >= MAX_ATTEMPTS) return giveUp(ctx, row, row.error ?? 'too many attempts');
    if (expiresAt !== null && now >= new Date(expiresAt)) {
      invoice = paymentHash = expiresAt = null; // confirmed unpaid and unpayable: get a new one
    }
  } else if (row.attempts >= MAX_ATTEMPTS) {
    return giveUp(ctx, row, row.error ?? 'too many attempts');
  }

  const attempt = row.attempts + 1;
  const retryAt = isoSeconds(new Date(now.getTime() + backoffMs(attempt)));
  const failAttempt = (error: string): StepResult => {
    if (attempt >= MAX_ATTEMPTS) return giveUp(ctx, row, error, attempt);
    if (!claim(ctx, row, { attempts: attempt, nextAttemptAt: retryAt, error })) return 'skipped';
    ctx.log.warn('payout attempt failed', { payout: row.id, attempt, error });
    return 'retry';
  };

  if (!invoice || !paymentHash) {
    const address = crewAddress(ctx, row.policyId);
    if (!address) return giveUp(ctx, row, 'crew has no Lightning address');
    try {
      const site = getSite(row.site)?.name ?? row.site;
      const inv = await ctx.resolver.requestInvoice(address, row.amountSat, `Ndox · ${site}`);
      ({ invoice, paymentHash, expiresAt } = inv);
    } catch (err) {
      return failAttempt(scrubError(errorMessage(err)));
    }
  }

  // Store the invoice before sending it: after a crash the next step looks it up instead.
  try {
    const stored = claim(ctx, row, {
      status: 'paying',
      invoice,
      paymentHash,
      invoiceExpiresAt: expiresAt,
      attempts: attempt,
      nextAttemptAt: retryAt,
      error: null,
    });
    if (!stored) return 'skipped';
  } catch (err) {
    if (isUniqueViolation(err)) return failAttempt('invoice already used by another payout');
    throw err;
  }

  try {
    const res = await ctx.wallet.payInvoice(invoice);
    if (!preimageMatches(res.preimage, paymentHash))
      throw new Error('wallet preimage does not match the payment hash');
    return markPaid(ctx, { ...row, status: 'paying' }, res.preimage, res.feeSat);
  } catch (err) {
    const error = scrubError(errorMessage(err));
    ctx.db
      .update(payouts)
      .set({ error, updatedAt: isoSeconds(ctx.clock()) })
      .where(and(eq(payouts.id, row.id), eq(payouts.status, 'paying')))
      .run();
    ctx.log.warn('payout attempt failed', { payout: row.id, attempt, error });
    return 'retry';
  }
}

export interface ProcessResult {
  processed: number;
  paid: number;
  retry: number;
  waiting: number;
  failed: number;
  errors: number;
}

function scope(ctx: PayoutCtx): SQL | undefined {
  if (!ctx.replay) return eq(payouts.replay, false);
  const own = ctx.db
    .select({ id: attestations.eventId })
    .from(attestations)
    .where(eq(attestations.replayRunId, ctx.replay.runId));
  return and(eq(payouts.replay, true), inArray(payouts.attestationId, own));
}

/** Steps every payout that is due (scheduler, once a minute). */
export async function processDuePayouts(ctx: PayoutCtx): Promise<ProcessResult> {
  const now = isoSeconds(ctx.clock());
  const due = ctx.db
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(
        scope(ctx),
        eq(payouts.wallet, ctx.wallet.kind),
        inArray(payouts.status, ['pending', 'paying']),
        or(isNull(payouts.nextAttemptAt), lte(payouts.nextAttemptAt, now)),
      ),
    )
    .orderBy(payouts.createdAt, payouts.id)
    .all();
  const r: ProcessResult = {
    processed: due.length,
    paid: 0,
    retry: 0,
    waiting: 0,
    failed: 0,
    errors: 0,
  };
  for (const { id } of due) {
    try {
      const step = await processPayout(ctx, id);
      if (step !== 'skipped') r[step]++;
    } catch (err) {
      r.errors++;
      ctx.log.error('payout step failed', { payout: id, error: scrubError(errorMessage(err)) });
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// receipts and run summaries

function signApp(ctx: PayoutCtx, d: string, tags: string[][], content: object): string {
  const event = finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: unixSeconds(ctx.clock()),
      tags: [['d', d], ...tags],
      content: JSON.stringify(content),
    },
    ctx.poolSecret,
  );
  return JSON.stringify(event);
}

function signPending(ctx: PayoutCtx): void {
  const receipts = ctx.db
    .select({ p: payouts, att: attestations, demo: policies.demo })
    .from(payouts)
    .innerJoin(attestations, eq(attestations.eventId, payouts.attestationId))
    .innerJoin(policies, eq(policies.id, payouts.policyId))
    .where(and(scope(ctx), eq(payouts.status, 'paid'), isNull(payouts.receiptJson)))
    .all();
  for (const { p, att, demo } of receipts) {
    const eventJson = signApp(
      ctx,
      `ndox:payout:${p.policyId}:${p.attestationId}`,
      [
        ['e', att.nostrId],
        ['t', p.replay ? 'ndox-replay' : 'ndox'],
        ['alt', 'Ndox: reçu de paiement (preuve Lightning : sha256(preimage) = payment_hash)'],
      ],
      {
        v: 1,
        policyId: p.policyId,
        attestationId: p.attestationId,
        attestationNostrId: att.nostrId,
        site: p.site,
        date: att.date,
        amountSat: p.amountSat,
        amountFcfa: p.amountFcfa,
        dueSat: p.dueSat,
        factorPpm: p.factorPpm,
        xofPerBtc: p.xofPerBtc,
        paymentHash: p.paymentHash,
        preimage: p.preimage,
        paidAt: p.paidAt,
        simulated: p.wallet === 'fake',
        replay: p.replay,
        demo,
      },
    );
    ctx.db
      .update(payouts)
      .set({ receiptJson: eventJson })
      .where(and(eq(payouts.id, p.id), isNull(payouts.receiptJson)))
      .run();
  }

  const runScope = ctx.replay
    ? inArray(
        payoutRuns.attestationId,
        ctx.db
          .select({ id: attestations.eventId })
          .from(attestations)
          .where(eq(attestations.replayRunId, ctx.replay.runId)),
      )
    : eq(payoutRuns.replay, false);
  const runs = ctx.db
    .select({ r: payoutRuns, nostrId: attestations.nostrId })
    .from(payoutRuns)
    .innerJoin(attestations, eq(attestations.eventId, payoutRuns.attestationId))
    .where(and(runScope, eq(payoutRuns.status, 'planned'), isNull(payoutRuns.eventJson)))
    .all();
  for (const { r, nostrId } of runs) {
    const eventJson = signApp(
      ctx,
      `ndox:payout-run:${r.attestationId}`,
      [
        ['e', nostrId],
        ['t', r.replay ? 'ndox-replay' : 'ndox'],
        ['alt', 'Ndox: bilan des paiements (dû, payé, manque)'],
      ],
      {
        v: 1,
        attestationId: r.attestationId,
        attestationNostrId: nostrId,
        site: r.site,
        date: r.date,
        outcome: r.outcome,
        policies: r.policies,
        dueSat: r.dueSat,
        availableSat: r.availableSat,
        planSat: r.planSat,
        shortfallSat: r.shortfallSat,
        factorPpm: r.factorPpm,
        limitedBy: r.limitedBy,
        xofPerBtc: r.xofPerBtc,
        priceAsOf: r.priceAsOf,
        priceStale: r.priceStale,
        simulated: r.wallet === 'fake',
        replay: r.replay,
      },
    );
    ctx.db
      .update(payoutRuns)
      .set({ eventJson })
      .where(and(eq(payoutRuns.attestationId, r.attestationId), isNull(payoutRuns.eventJson)))
      .run();
  }
}

/**
 * Signs receipts for paid payouts and summaries for planned runs, then publishes the unpublished
 * ones (live only; a replay signs and stores them). Returns how many were published.
 */
export async function publishPayoutEvents(ctx: PayoutCtx): Promise<number> {
  signPending(ctx);
  if (!ctx.publisher || ctx.replay) return 0;
  const publisher = ctx.publisher;
  const now = ctx.clock();
  let published = 0;
  const send = async (eventJson: string, last: unknown) => {
    if (!dueForRetry(last, now)) return null;
    try {
      return {
        ...(await publisher.publish(JSON.parse(eventJson) as NostrEvent)),
        at: isoSeconds(now),
      };
    } catch (err) {
      ctx.log.warn('payout event publish failed', { error: errorMessage(err) });
      return null;
    }
  };

  const receipts = ctx.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.replay, false), isNull(payouts.receiptPublishedAt)))
    .all()
    .filter((p) => p.receiptJson !== null);
  for (const p of receipts) {
    const res = await send(p.receiptJson!, p.receiptPublishResult);
    if (!res) continue;
    ctx.db
      .update(payouts)
      .set({ receiptPublishResult: res, receiptPublishedAt: res.ok ? res.at : null })
      .where(eq(payouts.id, p.id))
      .run();
    if (res.ok) published++;
  }
  const runs = ctx.db
    .select()
    .from(payoutRuns)
    .where(and(eq(payoutRuns.replay, false), isNull(payoutRuns.publishedAt)))
    .all()
    .filter((r) => r.eventJson !== null);
  for (const r of runs) {
    const res = await send(r.eventJson!, r.publishResult);
    if (!res) continue;
    ctx.db
      .update(payoutRuns)
      .set({ publishResult: res, publishedAt: res.ok ? res.at : null })
      .where(eq(payoutRuns.attestationId, r.attestationId))
      .run();
    if (res.ok) published++;
  }
  return published;
}

// ---------------------------------------------------------------------------
// scheduler job

export interface PayoutJobsResult {
  expiredPolicies: number;
  deposits: { checked: number; paid: number; expired: number };
  planned: string[];
  payouts: ProcessResult;
  published: number;
}

/** Everything money-related the live scheduler does each minute. */
export async function runPayoutJobs(ctx: PayoutCtx): Promise<PayoutJobsResult> {
  if (ctx.replay) throw new PayoutError('wrong_context', 'the scheduler drives the live pool only');
  const now = ctx.clock();
  const expiredPolicies = expirePolicies(ctx.db, now);
  const deposits = await pollDeposits(ctx);

  const since = isoSeconds(new Date(now.getTime() - PLAN_LOOKBACK_DAYS * 86_400_000));
  const unplanned = ctx.db
    .select({ id: attestations.eventId })
    .from(attestations)
    .leftJoin(payoutRuns, eq(payoutRuns.attestationId, attestations.eventId))
    .where(
      and(
        isNull(attestations.replayRunId),
        isNull(payoutRuns.attestationId),
        gte(attestations.createdAt, since),
      ),
    )
    .orderBy(attestations.createdAt)
    .all();
  const planned: string[] = [];
  for (const { id } of unplanned) {
    try {
      await planPayoutRun(ctx, id);
      planned.push(id);
    } catch (err) {
      ctx.log.error('payout planning failed', { attestationId: id, error: errorMessage(err) });
    }
  }

  const payoutsResult = await processDuePayouts(ctx);
  const published = (await publishPendingPolicies(ctx)) + (await publishPayoutEvents(ctx));
  return { expiredPolicies, deposits, planned, payouts: payoutsResult, published };
}
