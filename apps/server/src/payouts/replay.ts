/**
 * Payouts for a demo replay (docs/BRIEF.md §17, "everyone covered is paid before sunrise"). The
 * replayed attestation is paid exactly like a live one, with three differences that keep it from
 * ever touching real money:
 *  - the wallet is a FakeWallet account `replay:<runId>` that starts from a snapshot of the pool
 *    balance; the live pool is never debited;
 *  - crews' Lightning addresses are resolved by FakeLnAddressResolver (no network call);
 *  - only demo crews covered right now (real time) are paid, and nothing is published.
 * Payouts happen on the replay's simulated clock, one minute after the attestation.
 */
import { and, eq } from 'drizzle-orm';
import { crews, payouts, policies } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { isoSeconds } from '../lib/time.js';
import type { ReplayResult } from '../oracle/replay.js';
import { FakeLnAddressResolver, FakeWallet } from '../wallet/fake.js';
import {
  planPayoutRun,
  processDuePayouts,
  publishPayoutEvents,
  type PayoutCtx,
  type PayoutRunRow,
} from './engine.js';

export interface ReplayPayout {
  policyId: string;
  pseudonym: string;
  amountSat: number;
  amountFcfa: number;
  status: 'pending' | 'paying' | 'paid' | 'failed';
  paymentHash: string | null;
}

export interface ReplayPayoutSummary {
  runId: string;
  eventId: string;
  status: PayoutRunRow['status'];
  /** Always true: replays pay from a simulated wallet. */
  simulated: true;
  /** Simulated time of the payouts. */
  at: string;
  openingSat: number;
  policies: number;
  dueSat: number;
  planSat: number;
  paidSat: number;
  shortfallSat: number;
  factorPpm: number | null;
  limitedBy: PayoutRunRow['limitedBy'];
  paid: number;
  failed: number;
  payouts: ReplayPayout[];
}

export interface ReplayPayoutOptions {
  /** FakeWallet seed (32-byte hex). */
  fakeSeed: string;
  /** DEMO_ORACLE_SECRET's public key: the replay attestation must be signed by it. */
  demoOraclePubkey: string;
}

export async function payReplay(
  live: PayoutCtx,
  result: Pick<ReplayResult, 'runId' | 'eventId' | 'steps'>,
  o: ReplayPayoutOptions,
): Promise<ReplayPayoutSummary> {
  const attestedAt = result.steps.find((s) => s.step === 'attest')?.at;
  const simulated = new Date(Date.parse(attestedAt ?? isoSeconds(live.clock())) + 60_000);
  const clock = () => simulated;

  let openingSat = 0;
  try {
    openingSat = await live.wallet.getBalanceSat();
  } catch (err) {
    live.log.warn('replay: pool balance unavailable, the replay wallet starts empty', {
      error: errorMessage(err),
    });
  }
  const ctx: PayoutCtx = {
    ...live,
    clock,
    wallet: new FakeWallet({
      db: live.db,
      seed: o.fakeSeed,
      account: `replay:${result.runId}`,
      clock,
      openingSat,
    }),
    resolver: new FakeLnAddressResolver({ db: live.db, seed: o.fakeSeed, clock }),
    publisher: null,
    oraclePubkey: o.demoOraclePubkey,
    replay: { runId: result.runId, coverAt: live.clock() },
  };

  const run = await planPayoutRun(ctx, result.eventId);
  await processDuePayouts(ctx);
  await publishPayoutEvents(ctx); // signs receipts; replays are never published

  const rows = live.db
    .select({ p: payouts, pseudonym: crews.pseudonym })
    .from(payouts)
    .innerJoin(policies, eq(policies.id, payouts.policyId))
    .innerJoin(crews, eq(crews.id, policies.crewId))
    .where(and(eq(payouts.attestationId, result.eventId), eq(payouts.replay, true)))
    .orderBy(crews.pseudonym)
    .all();
  const paid = rows.filter((r) => r.p.status === 'paid');
  return {
    runId: result.runId,
    eventId: result.eventId,
    status: run.status,
    simulated: true,
    at: isoSeconds(simulated),
    openingSat,
    policies: run.policies,
    dueSat: run.dueSat,
    planSat: run.planSat,
    paidSat: paid.reduce((s, r) => s + r.p.amountSat, 0),
    shortfallSat: run.shortfallSat,
    factorPpm: run.factorPpm,
    limitedBy: run.limitedBy,
    paid: paid.length,
    failed: rows.filter((r) => r.p.status === 'failed').length,
    payouts: rows.map(({ p, pseudonym }) => ({
      policyId: p.policyId,
      pseudonym,
      amountSat: p.amountSat,
      amountFcfa: p.amountFcfa,
      status: p.status,
      paymentHash: p.paymentHash,
    })),
  };
}
