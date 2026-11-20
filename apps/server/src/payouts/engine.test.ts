import { getPublicKey, getTag, verifyEvent, type NostrEvent } from '@ndox/oracle';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { eq, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { attestations, fakeInvoices, payoutRuns, payouts, policies } from '../db/schema.js';
import { deriveKey } from '../lib/box.js';
import { silentLog } from '../lib/log.js';
import { PriceService } from '../money/price.js';
import { MemoryPublisher } from '../nostr/publisher.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { runReplay } from '../oracle/replay.js';
import { DEFAULT_PATHS } from '../paths.js';
import { enrolCrew } from '../pool/crews.js';
import { createDeposit, refreshDeposit } from '../pool/deposits.js';
import { createPolicy, policyStatusAt } from '../pool/policies.js';
import { Pricing } from '../pool/pricing.js';
import type { PolicySettings } from '../pool/settings.js';
import {
  makeCtx,
  memoryDb,
  settableClock,
  StubSource,
  TEST_DEMO_SECRET,
  TEST_ORACLE_SECRET,
} from '../test/helpers.js';
import { FakeLnAddressResolver, FakeWallet } from '../wallet/fake.js';
import type { LnAddressResolver, Wallet } from '../wallet/types.js';
import { SeedSource } from '../wave/source.js';
import {
  MAX_ATTEMPTS,
  planPayoutRun,
  processDuePayouts,
  processPayout,
  publishPayoutEvents,
  runPayoutJobs,
  type PayoutCtx,
} from './engine.js';
import { payReplay } from './replay.js';

const PII = deriveKey('3d'.repeat(32), 'pii');
const POOL_SECRET = '4c'.repeat(32);
const SEED = '5a'.repeat(32);
const DEFAULTS: PolicySettings = {
  payoutFcfa: 2000,
  waitingHours: 72,
  premiumLoading: 0.25,
  dailyPayoutCapSats: 1_000_000,
  reserveFloorSats: 0,
};
/** 2000 FCFA at 57 941 EUR/BTC (38 006 805 XOF/BTC), rounded. */
const PAYOUT_SAT = 5262;
/** Kayar weekly premium (1006 FCFA), rounded up. */
const PREMIUM_SAT = 2647;
const pricing = Pricing.load(DEFAULT_PATHS.seedDir);

const T0 = '2026-11-19T12:00:00Z'; // premiums paid → covered from 2026-11-22T12:00Z
const D = '2026-11-23';
const AFTER_ATTEST = '2026-11-23T05:16:00Z';

function sha256Hex(hex: string): string {
  return bytesToHex(sha256(hexToBytes(hex)));
}

class FlakyWallet implements Wallet {
  readonly kind = 'fake' as const;
  readonly simulated = true;
  /** Next payInvoice calls: fail before sending, or send and then lose the answer. */
  failures: ('before' | 'after')[] = [];
  payCalls = 0;
  constructor(private readonly inner: FakeWallet) {}
  makeInvoice(amountSat: number, memo: string, expirySec?: number) {
    return this.inner.makeInvoice(amountSat, memo, expirySec);
  }
  async payInvoice(invoice: string) {
    this.payCalls++;
    const f = this.failures.shift();
    if (f === 'before') throw new Error('connection lost');
    const r = await this.inner.payInvoice(invoice);
    if (f === 'after') throw new Error('timed out waiting for the wallet');
    return r;
  }
  lookupInvoice(paymentHash: string) {
    return this.inner.lookupInvoice(paymentHash);
  }
  getBalanceSat() {
    return this.inner.getBalanceSat();
  }
}

function setup(
  o: {
    settings?: Partial<PolicySettings>;
    heights?: Record<string, number | Error>;
    resolver?: LnAddressResolver;
  } = {},
) {
  const db = memoryDb();
  const t = settableClock(T0);
  const pool = new FakeWallet({ db, seed: SEED, account: 'pool', clock: t.clock });
  const wallet = new FlakyWallet(pool);
  const prices = new PriceService({
    db,
    clock: t.clock,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch,
  });
  const publisher = new MemoryPublisher();
  const ctx: PayoutCtx = {
    db,
    wallet,
    prices,
    clock: t.clock,
    poolSecret: POOL_SECRET,
    publisher,
    relays: ['wss://relay.example'],
    pricing,
    settings: () => ({ ...DEFAULTS, ...o.settings }),
    log: silentLog,
    piiKey: PII,
    resolver: o.resolver ?? new FakeLnAddressResolver({ db, seed: SEED, clock: t.clock }),
    oraclePubkey: getPublicKey(TEST_ORACLE_SECRET),
  };
  const oracle = makeCtx(db, {
    clock: t.clock,
    source: StubSource.constant(o.heights ?? { ecmwf_wam: 2.86, ncep_gfswave025: 2.62 }),
  });
  return { db, t, pool, wallet, ctx, oracle, publisher };
}
type S = ReturnType<typeof setup>;

async function payDeposit(s: S, paymentHash: string) {
  expect(s.pool.simulatePayment(paymentHash)).toBe(true);
  await refreshDeposit(s.ctx, paymentHash);
}

async function fund(s: S, amountFcfa: number) {
  const d = await createDeposit(s.ctx, { kind: 'levy', amountFcfa });
  await payDeposit(s, d.paymentHash!);
}

/** Enrols a demo crew and pays one week of premium now. */
async function coverCrew(s: S, n: number, site = 'kayar', demo = true) {
  const crew = enrolCrew(s.db, PII, {
    site,
    lnAddress: `crew${n}@demo.ndox.invalid`,
    demo,
  });
  const weekly = pricing.weeklyPremiumFcfa(site, 2.5, s.ctx.settings());
  const p = createPolicy(s.db, {
    crewId: crew.id,
    fundedBy: 'crew',
    weeks: 1,
    payoutFcfa: 2000,
    premiumWeeklyFcfa: weekly,
  });
  const d = await createDeposit(s.ctx, { kind: 'premium', policyId: p.id });
  await payDeposit(s, d.paymentHash!);
  return { crew, policyId: p.id };
}

/** Live oracle day: announce on the eve, fetch, attest; leaves the clock just after 05:15. */
async function attestDay(s: S, site = 'kayar', date = D): Promise<string> {
  s.t.set(`${date.slice(0, 8)}${String(Number(date.slice(8)) - 1).padStart(2, '0')}T20:00:00Z`);
  await announce(s.oracle, site, date);
  s.t.set(`${date}T05:00:00Z`);
  await fetchForecasts(s.oracle, site, date);
  s.t.set(`${date}T05:15:00Z`);
  const r = await attest(s.oracle, site, date);
  s.t.set(`${date}T05:16:00Z`);
  return r.eventId;
}

const payoutRows = (db: Db, attestationId: string) =>
  db.select().from(payouts).where(eq(payouts.attestationId, attestationId)).all();
const extInvoices = (db: Db) =>
  db.select().from(fakeInvoices).where(like(fakeInvoices.account, 'ext:%')).all();

describe('payout engine — plan', () => {
  it('pays every covered crew once; running the engine again pays nothing more', async () => {
    const s = setup();
    await fund(s, 100_000);
    const crews = [await coverCrew(s, 1), await coverCrew(s, 2), await coverCrew(s, 3)];
    const eventId = await attestDay(s);
    expect(s.t.clock()).toEqual(new Date(AFTER_ATTEST));
    const before = await s.wallet.getBalanceSat();

    const run = await planPayoutRun(s.ctx, eventId);
    expect(run).toMatchObject({
      status: 'planned',
      outcome: 'danger',
      replay: false,
      wallet: 'fake',
      policies: 3,
      xofPerBtc: 38_006_805,
      balanceSat: before,
      outstandingSat: 0,
      paidTodaySat: 0,
      dueSat: 3 * PAYOUT_SAT,
      planSat: 3 * PAYOUT_SAT,
      shortfallSat: 0,
      factorPpm: 1_000_000,
      limitedBy: null,
    });
    expect((run.verification as { ok: boolean }).ok).toBe(true);
    expect(await planPayoutRun(s.ctx, eventId)).toEqual(run);
    expect(payoutRows(s.db, eventId)).toHaveLength(3);

    const r1 = await processDuePayouts(s.ctx);
    expect(r1).toMatchObject({ paid: 3, failed: 0 });
    expect(await processDuePayouts(s.ctx)).toMatchObject({ processed: 0, paid: 0 });
    // a restarted engine plans and steps again: still one payment per crew
    await planPayoutRun(s.ctx, eventId);
    await processDuePayouts(s.ctx);

    expect(before - (await s.wallet.getBalanceSat())).toBe(3 * PAYOUT_SAT);
    expect(s.wallet.payCalls).toBe(3);
    const rows = payoutRows(s.db, eventId);
    expect(rows.map((p) => p.policyId).sort()).toEqual(crews.map((c) => c.policyId).sort());
    for (const p of rows) {
      expect(p).toMatchObject({ status: 'paid', amountSat: PAYOUT_SAT, amountFcfa: 2000 });
      expect(p.attempts).toBe(1);
      expect(sha256Hex(p.preimage!)).toBe(p.paymentHash);
    }
    const ext = extInvoices(s.db);
    expect(ext).toHaveLength(3);
    expect(ext.every((i) => i.status === 'paid' && i.paidBy === 'pool')).toBe(true);
  });

  it('does not pay a policy still in its 72 h waiting period', async () => {
    const s = setup();
    await fund(s, 100_000);
    const a = await coverCrew(s, 1);
    s.t.set('2026-11-21T12:00:00Z'); // covered only from 2026-11-24T12:00Z
    const b = await coverCrew(s, 2);
    const eventId = await attestDay(s);

    const run = await planPayoutRun(s.ctx, eventId);
    expect(run.policies).toBe(1);
    expect(payoutRows(s.db, eventId).map((p) => p.policyId)).toEqual([a.policyId]);
    const pb = s.db.select().from(policies).where(eq(policies.id, b.policyId)).get()!;
    expect(policyStatusAt(pb, new Date(`${D}T06:00:00Z`))).toBe('waiting');
  });

  it('records "no payout" for a calm day', async () => {
    const s = setup({ heights: { ecmwf_wam: 1.2, ncep_gfswave025: 1.1 } });
    await fund(s, 100_000);
    await coverCrew(s, 1);
    const eventId = await attestDay(s);
    const run = await planPayoutRun(s.ctx, eventId);
    expect(run).toMatchObject({ status: 'no_payout', outcome: 'calme', dueSat: 0, planSat: 0 });
    expect(payoutRows(s.db, eventId)).toHaveLength(0);
  });

  it('pays pro rata when the pool is short, keeps the reserve floor, and records the shortfall', async () => {
    const s = setup({ settings: { reserveFloorSats: 1000 } });
    for (const n of [1, 2, 3]) await coverCrew(s, n); // pool = 3 premiums only
    const eventId = await attestDay(s);
    expect(await s.wallet.getBalanceSat()).toBe(3 * PREMIUM_SAT);

    const run = await planPayoutRun(s.ctx, eventId);
    expect(run).toMatchObject({
      status: 'planned',
      balanceSat: 3 * PREMIUM_SAT,
      reserveFloorSat: 1000,
      dueSat: 3 * PAYOUT_SAT,
      availableSat: 3 * PREMIUM_SAT - 1000,
      planSat: 6939,
      shortfallSat: 8847,
      factorPpm: 439_693, // floor(6941e6 / 15786)
      limitedBy: 'balance',
    });
    await processDuePayouts(s.ctx);
    const rows = payoutRows(s.db, eventId);
    expect(rows.map((p) => [p.status, p.dueSat, p.amountSat])).toEqual([
      ['paid', PAYOUT_SAT, 2313],
      ['paid', PAYOUT_SAT, 2313],
      ['paid', PAYOUT_SAT, 2313],
    ]);
    expect(await s.wallet.getBalanceSat()).toBe(3 * PREMIUM_SAT - 6939);
  });

  it('respects the daily cap across sites on the same day', async () => {
    const s = setup({ settings: { dailyPayoutCapSats: 10_000 } });
    await fund(s, 100_000);
    for (const n of [1, 2, 3]) await coverCrew(s, n);
    await coverCrew(s, 4, 'saint-louis');
    const kayar = await attestDay(s, 'kayar');
    const r1 = await planPayoutRun(s.ctx, kayar);
    expect(r1).toMatchObject({
      dailyCapSat: 10_000,
      planSat: 9999,
      shortfallSat: 5787,
      factorPpm: 633_472, // floor(10000e6 / 15786)
      limitedBy: 'daily_cap',
    });

    const stl = await attestDay(s, 'saint-louis');
    const r2 = await planPayoutRun(s.ctx, stl);
    expect(r2).toMatchObject({
      paidTodaySat: 9999,
      outstandingSat: 9999, // Kayar payouts planned, not yet sent
      availableSat: 1,
      planSat: 1,
      limitedBy: 'daily_cap',
    });
  });

  it('a real wallet never pays demo policies (e.g. a database switched from fake to live)', async () => {
    const s = setup();
    await fund(s, 100_000);
    await coverCrew(s, 1); // demo
    const real = await coverCrew(s, 2, 'kayar', false);
    const eventId = await attestDay(s);
    const realWallet: Wallet = {
      kind: 'nwc',
      simulated: false,
      makeInvoice: (a, m, e) => s.pool.makeInvoice(a, m, e),
      payInvoice: (i) => s.pool.payInvoice(i),
      lookupInvoice: (h) => s.pool.lookupInvoice(h),
      getBalanceSat: () => s.pool.getBalanceSat(),
    };
    const run = await planPayoutRun({ ...s.ctx, wallet: realWallet }, eventId);
    expect(run).toMatchObject({ status: 'planned', policies: 1, wallet: 'nwc' });
    expect(payoutRows(s.db, eventId).map((p) => [p.policyId, p.wallet])).toEqual([
      [real.policyId, 'nwc'],
    ]);
    // and the fake-mode engine leaves a real-wallet payout alone
    expect(await processPayout(s.ctx, payoutRows(s.db, eventId)[0]!.id)).toBe('skipped');
  });

  it('a test-funds wallet (NWC on a test network) pays demo policies too', async () => {
    const s = setup();
    await fund(s, 100_000);
    const demo = await coverCrew(s, 1); // demo
    const real = await coverCrew(s, 2, 'kayar', false);
    const eventId = await attestDay(s);
    const testWallet: Wallet = {
      kind: 'nwc',
      simulated: false,
      makeInvoice: (a, m, e) => s.pool.makeInvoice(a, m, e),
      payInvoice: (i) => s.pool.payInvoice(i),
      lookupInvoice: (h) => s.pool.lookupInvoice(h),
      getBalanceSat: () => s.pool.getBalanceSat(),
    };
    const run = await planPayoutRun({ ...s.ctx, wallet: testWallet, testFunds: true }, eventId);
    expect(run).toMatchObject({ status: 'planned', policies: 2, wallet: 'nwc' });
    expect(
      payoutRows(s.db, eventId)
        .map((p) => p.policyId)
        .sort(),
    ).toEqual([demo.policyId, real.policyId].sort());
  });

  it('refuses an attestation from the wrong oracle key', async () => {
    const s = setup();
    await fund(s, 100_000);
    await coverCrew(s, 1);
    const eventId = await attestDay(s);
    const run = await planPayoutRun(
      { ...s.ctx, oraclePubkey: getPublicKey(TEST_DEMO_SECRET) },
      eventId,
    );
    expect(run.status).toBe('invalid');
    expect((run.verification as { ok: boolean }).ok).toBe(false);
    expect(payoutRows(s.db, eventId)).toHaveLength(0);
  });

  it('refuses a stored attestation whose signed content was altered', async () => {
    const s = setup();
    await fund(s, 100_000);
    await coverCrew(s, 1);
    const eventId = await attestDay(s);
    const row = s.db.select().from(attestations).where(eq(attestations.eventId, eventId)).get()!;
    const ev = JSON.parse(row.eventJson) as NostrEvent;
    ev.content = ev.content.replace('"danger"', '"calme"');
    s.db
      .update(attestations)
      .set({ eventJson: JSON.stringify(ev) })
      .where(eq(attestations.eventId, eventId))
      .run();
    const run = await planPayoutRun(s.ctx, eventId);
    expect(run.status).toBe('invalid');
    expect(payoutRows(s.db, eventId)).toHaveLength(0);
  });

  it('never pays a replay attestation from the live pool', async () => {
    const s = setup();
    const r = await runReplay(
      {
        db: s.db,
        demoSecret: TEST_DEMO_SECRET,
        source: new SeedSource(DEFAULT_PATHS.seedDir),
        publisher: null,
        relays: [],
        log: silentLog,
        now: s.t.clock,
      },
      'kayar',
      '2026-02-27',
    );
    await expect(planPayoutRun(s.ctx, r.eventId)).rejects.toThrow(/replay/);
    expect(s.db.select().from(payoutRuns).all()).toHaveLength(0);
  });
});

describe('payout engine — paying', () => {
  async function plannedOne(o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    await fund(s, 100_000);
    await coverCrew(s, 1);
    const eventId = await attestDay(s);
    await planPayoutRun(s.ctx, eventId);
    const id = payoutRows(s.db, eventId)[0]!.id;
    const row = () => s.db.select().from(payouts).where(eq(payouts.id, id)).get()!;
    return { s, eventId, id, row };
  }

  it('crash before sending: retries the same stored invoice, never asks for a second one', async () => {
    const { s, id, row } = await plannedOne();
    const before = await s.wallet.getBalanceSat();
    s.wallet.failures = ['before'];
    expect(await processPayout(s.ctx, id)).toBe('retry');
    const stored = row();
    expect(stored).toMatchObject({ status: 'paying', attempts: 1, error: 'connection lost' });
    expect(stored.invoice).toMatch(/^lnbcrt/);
    expect(await processPayout(s.ctx, id)).toBe('waiting'); // backoff: 60 s

    s.t.set('2026-11-23T05:17:00Z');
    expect(await processPayout(s.ctx, id)).toBe('paid');
    expect(row()).toMatchObject({ status: 'paid', attempts: 2, paymentHash: stored.paymentHash });
    expect(extInvoices(s.db)).toHaveLength(1);
    expect(before - (await s.wallet.getBalanceSat())).toBe(PAYOUT_SAT);
  });

  it('crash after sending: the lookup finds the payment, nothing is paid twice', async () => {
    const { s, id, row } = await plannedOne();
    const before = await s.wallet.getBalanceSat();
    s.wallet.failures = ['after'];
    expect(await processPayout(s.ctx, id)).toBe('retry');
    expect(row().status).toBe('paying');

    s.t.set('2026-11-23T05:17:00Z');
    expect(await processPayout(s.ctx, id)).toBe('paid');
    expect(s.wallet.payCalls).toBe(1);
    expect(row()).toMatchObject({ status: 'paid', attempts: 1, feeSat: null });
    expect(sha256Hex(row().preimage!)).toBe(row().paymentHash);
    expect(before - (await s.wallet.getBalanceSat())).toBe(PAYOUT_SAT);
  });

  it('asks for a new invoice only once the stored one has expired unpaid', async () => {
    const { s, id, row } = await plannedOne();
    s.wallet.failures = ['before'];
    await processPayout(s.ctx, id);
    const first = row();

    s.t.set('2026-11-23T06:17:00Z'); // first invoice expired (1 h)
    expect(await processPayout(s.ctx, id)).toBe('paid');
    const paid = row();
    expect(paid.paymentHash).not.toBe(first.paymentHash);
    expect(paid.attempts).toBe(2);
    const ext = extInvoices(s.db);
    expect(ext.map((i) => i.status).sort()).toEqual(['open', 'paid']);
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts, and a failed payout does not count against the cap`, async () => {
    const resolver: LnAddressResolver = {
      requestInvoice: () => Promise.reject(new Error('LNURL endpoint timed out')),
    };
    const { s, id, row } = await plannedOne({ resolver });
    const results: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      s.t.set(new Date(s.t.clock().getTime() + 60 * 60_000).toISOString());
      results.push(await processPayout(s.ctx, id));
    }
    expect(results).toEqual(['retry', 'retry', 'retry', 'retry', 'failed']);
    expect(row()).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      error: 'LNURL endpoint timed out',
    });
    expect(await processPayout(s.ctx, id)).toBe('skipped');
    expect(s.wallet.payCalls).toBe(0);
  });

  it('keeps invoices and Lightning addresses out of stored errors', async () => {
    const resolver: LnAddressResolver = {
      requestInvoice: () =>
        Promise.reject(new Error('crew1@demo.ndox.invalid refused lnbcrt52620n1pjqqqqq')),
    };
    const { s, id, row } = await plannedOne({ resolver });
    await processPayout(s.ctx, id);
    expect(row().error).toBe('[address] refused [invoice]');
  });
});

describe('payout engine — receipts and jobs', () => {
  it('publishes one signed receipt per payment and a public run summary, without personal data', async () => {
    const s = setup();
    await fund(s, 100_000);
    const crews = [await coverCrew(s, 1), await coverCrew(s, 2)];
    const eventId = await attestDay(s);
    await planPayoutRun(s.ctx, eventId);
    await processDuePayouts(s.ctx);
    s.publisher.events.length = 0;

    expect(await publishPayoutEvents(s.ctx)).toBe(3);
    expect(await publishPayoutEvents(s.ctx)).toBe(0);
    const pool = getPublicKey(POOL_SECRET);
    const att = s.db.select().from(attestations).where(eq(attestations.eventId, eventId)).get()!;
    const receipts = s.publisher.events.filter((e) => getTag(e, 'd')?.startsWith('ndox:payout:'));
    expect(receipts).toHaveLength(2);
    for (const e of receipts) {
      expect(verifyEvent(e)).toBe(true);
      expect(e.kind).toBe(30078);
      expect(e.pubkey).toBe(pool);
      expect(getTag(e, 'e')).toBe(att.nostrId);
      const c = JSON.parse(e.content) as Record<string, unknown>;
      expect(getTag(e, 'd')).toBe(`ndox:payout:${String(c.policyId)}:${eventId}`);
      expect(Object.keys(c).sort()).toEqual(
        [
          'v',
          'policyId',
          'attestationId',
          'attestationNostrId',
          'site',
          'date',
          'amountSat',
          'amountFcfa',
          'dueSat',
          'factorPpm',
          'xofPerBtc',
          'paymentHash',
          'preimage',
          'paidAt',
          'simulated',
          'replay',
          'demo',
        ].sort(),
      );
      expect(sha256Hex(c.preimage as string)).toBe(c.paymentHash);
      expect(c).toMatchObject({ amountSat: PAYOUT_SAT, simulated: true, replay: false });
      for (const secret of ['crew1@', 'crew2@', crews[0]!.crew.id, crews[0]!.crew.pseudonym])
        expect(e.content).not.toContain(secret);
    }
    const summary = s.publisher.events.find((e) => getTag(e, 'd') === `ndox:payout-run:${eventId}`);
    expect(summary).toBeDefined();
    expect(JSON.parse(summary!.content)).toMatchObject({
      attestationId: eventId,
      outcome: 'danger',
      policies: 2,
      dueSat: 2 * PAYOUT_SAT,
      planSat: 2 * PAYOUT_SAT,
      shortfallSat: 0,
      factorPpm: 1_000_000,
      simulated: true,
    });
    expect(
      s.db
        .select()
        .from(payouts)
        .all()
        .every((p) => p.receiptPublishedAt !== null),
    ).toBe(true);
  });

  it('the scheduler job plans recent live attestations, pays, and publishes', async () => {
    const s = setup();
    await fund(s, 100_000);
    await coverCrew(s, 1);
    const eventId = await attestDay(s);
    const r = await runPayoutJobs(s.ctx);
    expect(r.planned).toEqual([eventId]);
    expect(r.payouts).toMatchObject({ paid: 1 });
    expect(r.published).toBe(2); // receipt + run summary
    expect(await runPayoutJobs(s.ctx)).toMatchObject({ planned: [], payouts: { processed: 0 } });

    // an attestation more than 7 days old is never planned automatically
    s.db.delete(payouts).run();
    s.db.delete(payoutRuns).run();
    s.t.set('2026-12-01T06:00:00Z');
    expect((await runPayoutJobs(s.ctx)).planned).toEqual([]);
  });
});

describe('replay payouts', () => {
  it('a full replay pays the demo crews from a simulated replay wallet, never the pool', async () => {
    const s = setup();
    await fund(s, 100_000);
    const a = await coverCrew(s, 1);
    const b = await coverCrew(s, 2);
    await coverCrew(s, 3, 'kayar', false); // real crew: never paid by a replay
    s.t.set('2026-11-23T10:00:00Z'); // all three covered now
    const poolBefore = await s.wallet.getBalanceSat();

    const result = await runReplay(
      {
        db: s.db,
        demoSecret: TEST_DEMO_SECRET,
        source: new SeedSource(DEFAULT_PATHS.seedDir),
        publisher: null,
        relays: [],
        log: silentLog,
        now: s.t.clock,
      },
      'kayar',
      '2026-02-27',
    );
    expect(result.outcome).toBe('danger');
    const summary = await payReplay(s.ctx, result, {
      fakeSeed: SEED,
      demoOraclePubkey: getPublicKey(TEST_DEMO_SECRET),
    });

    expect(summary).toMatchObject({
      status: 'planned',
      simulated: true,
      openingSat: poolBefore,
      policies: 2,
      paid: 2,
      failed: 0,
      paidSat: 2 * PAYOUT_SAT,
      shortfallSat: 0,
      at: '2026-02-27T05:16:00Z',
    });
    expect(summary.payouts.map((p) => p.policyId).sort()).toEqual([a.policyId, b.policyId].sort());
    expect(
      summary.payouts.every((p) => p.status === 'paid' && /^Pirogue K-0[12]$/.test(p.pseudonym)),
    ).toBe(true);

    expect(await s.wallet.getBalanceSat()).toBe(poolBefore); // live pool untouched
    const rows = payoutRows(s.db, result.eventId);
    expect(rows.every((p) => p.replay && p.wallet === 'fake' && p.receiptJson !== null)).toBe(true);
    expect(rows.every((p) => p.receiptPublishedAt === null)).toBe(true); // replays are not published
    expect(
      s.publisher.events.filter(
        (e) => e.kind === 30078 && getTag(e, 'd')?.startsWith('ndox:payout'),
      ),
    ).toHaveLength(0);
    const replayDebits = s.db
      .select()
      .from(fakeInvoices)
      .where(eq(fakeInvoices.paidBy, `replay:${result.runId}`))
      .all();
    expect(replayDebits).toHaveLength(2);
  });
});
