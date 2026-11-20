import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { silentLog } from '../lib/log.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { DEFAULT_PATHS } from '../paths.js';
import { runPayoutJobs } from '../payouts/engine.js';
import { enrolCrew } from '../pool/crews.js';
import { createServices, type ServiceOverrides } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { FakeWallet } from '../wallet/fake.js';
import type { Wallet } from '../wallet/types.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};
const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

async function setup(o: ServiceOverrides = {}) {
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
  });
  const db = memoryDb();
  const t = settableClock('2026-11-19T12:00:00Z');
  const services = createServices(config, db, silentLog, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
    publisher: null,
    priceFetch,
    ...o,
  });
  const app = await buildApp({ services });
  return { app, services, t, db };
}
type S = Awaited<ReturnType<typeof setup>>;

interface SponsorView {
  paymentHash: string;
  status: string;
  amountSat: number;
  amountFcfa: number;
  crew: string | null;
  cover: { activeFrom: string; activeUntil: string } | null;
  simulated: boolean;
  invoice?: string;
  coverWeeks?: number | null;
}

async function sponsor(s: S, body: object): Promise<SponsorView> {
  const res = await s.app.inject({ method: 'POST', url: '/api/sponsor/invoice', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json<SponsorView>();
}
async function simulate(s: S, hash: string) {
  return s.app.inject({ method: 'POST', url: `/api/sponsor/invoice/${hash}/simulate` });
}

describe('money API', () => {
  it('GET /api/pool shows an empty simulated pool honestly', async () => {
    const s = await setup();
    const res = await s.app.inject('/api/pool');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      wallet: { kind: 'fake', simulated: true, network: 'mainnet' },
      balanceSat: 0,
      availableSat: 0,
      outstandingSat: 0,
      dailyCapSat: 250_000,
      payoutFcfa: 2000,
      price: { xofPerBtc: 38_006_805, source: 'mempool.space', stale: false },
      coverage: { ratio: null, exposureSat: 0 },
      policies: { covered: 0, waiting: 0, awaitingPremium: 0 },
      payouts: { count: 0, sat: 0 },
      shortfalls: [],
    });
  });

  it('a sponsor gift to a crew: invoice, simulated payment, weeks of cover', async () => {
    const s = await setup();
    const crew = enrolCrew(s.db, s.services.piiKey, {
      site: 'kayar',
      lnAddress: 'k1@demo.ndox.invalid',
      demo: true,
    });
    const inv = await sponsor(s, { amountFcfa: 5000, crewPseudonym: crew.pseudonym });
    expect(inv).toMatchObject({
      status: 'pending',
      amountFcfa: 5000,
      crew: 'Pirogue K-01',
      cover: null,
      simulated: true,
      coverWeeks: 4,
    });
    expect(inv.invoice).toMatch(/^lnbcrt/);
    const get = await s.app.inject(`/api/sponsor/invoice/${inv.paymentHash}`);
    expect(get.json()).toMatchObject({ status: 'pending' });
    expect(get.json()).not.toHaveProperty('invoice');

    const paid = await simulate(s, inv.paymentHash);
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({
      status: 'paid',
      cover: { activeFrom: '2026-11-22T12:00:00Z', activeUntil: '2026-12-20T12:00:00Z' },
    });
    expect((await simulate(s, inv.paymentHash)).json()).toMatchObject({ status: 'paid' });

    const pool = (await s.app.inject('/api/pool')).json<{
      balanceSat: number;
      deposits: { sponsor: number };
      policies: { waiting: number };
      coverage: { ratio: number; exposureSat: number };
    }>();
    expect(pool.balanceSat).toBe(inv.amountSat);
    expect(pool.deposits.sponsor).toBe(inv.amountSat);
    expect(pool.policies.waiting).toBe(1);
    expect(pool.coverage.exposureSat).toBe(5262 * 7); // one crew × 2000 FCFA × Kayar's worst week
    expect(pool.coverage.ratio).toBeCloseTo(inv.amountSat / (5262 * 7), 2);
  });

  it('lists only active demo crews for sponsors, by pseudonym and site', async () => {
    const s = await setup();
    const demo = enrolCrew(s.db, s.services.piiKey, {
      site: 'joal',
      lnAddress: 'j1@demo.ndox.invalid',
      demo: true,
    });
    enrolCrew(s.db, s.services.piiKey, {
      site: 'kayar',
      lnAddress: 'real@example.com',
      phone: '+221770000000',
      demo: false,
    });
    const res = await s.app.inject('/api/sponsor/crews');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ pseudonym: demo.pseudonym, site: 'joal' }] });
    expect(res.body).not.toContain('example.com');
    // no zap address is advertised next to a simulated wallet
    expect((await s.app.inject('/api/meta')).json()).toMatchObject({ poolLightningAddress: null });
  });

  it('rejects bad sponsor requests without detail, and rate-limits invoices', async () => {
    const s = await setup();
    const bad = async (payload: object) =>
      s.app.inject({ method: 'POST', url: '/api/sponsor/invoice', payload });
    expect((await bad({ amountFcfa: 50 })).statusCode).toBe(400);
    expect((await bad({ amountFcfa: 1000, extra: 1 })).statusCode).toBe(400);
    const unknown = await bad({ amountFcfa: 1000, crewPseudonym: 'Pirogue Z-99' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: 'unknown_crew' });
    expect((await s.app.inject('/api/sponsor/invoice/zz')).statusCode).toBe(400);
    expect((await s.app.inject(`/api/sponsor/invoice/${'0'.repeat(64)}`)).statusCode).toBe(404);

    for (let i = 0; i < 7; i++) await sponsor(s, { amountFcfa: 1000 }); // 3 bad + 7 = 10
    const limited = await bad({ amountFcfa: 1000 });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a danger day: payouts and the run summary are public, with payment proofs', async () => {
    const s = await setup();
    const fundInv = await sponsor(s, { amountFcfa: 100_000 });
    await simulate(s, fundInv.paymentHash);
    const crew = enrolCrew(s.db, s.services.piiKey, {
      site: 'kayar',
      lnAddress: 'k1@demo.ndox.invalid',
      demo: true,
    });
    const gift = await sponsor(s, { amountFcfa: 1006, crewPseudonym: crew.pseudonym });
    await simulate(s, gift.paymentHash);

    s.t.set('2026-11-22T20:00:00Z');
    await announce(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T05:00:00Z');
    await fetchForecasts(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T05:15:00Z');
    const att = await attest(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T05:16:00Z');
    const jobs = await runPayoutJobs(s.services.money);
    expect(jobs.payouts.paid).toBe(1);

    const list = (await s.app.inject('/api/payouts')).json<{ items: Record<string, unknown>[] }>();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      attestationId: att.eventId,
      status: 'paid',
      amountSat: 5262,
      simulated: true,
    });
    expect(list.items[0]!.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(list)).not.toContain('k1@');
    expect(JSON.stringify(list)).not.toContain(crew.pseudonym);

    const detail = (await s.app.inject(`/api/attestations/${att.eventId}`)).json<{
      payoutRun: Record<string, unknown> & { event: { tags: string[][] } | null };
      payouts: { simulated: boolean; receipt: unknown }[];
    }>();
    expect(detail.payoutRun).toMatchObject({
      status: 'planned',
      policies: 1,
      dueSat: 5262,
      planSat: 5262,
      shortfallSat: 0,
      simulated: true,
    });
    expect(detail.payoutRun.event?.tags[0]).toEqual(['d', `ndox:payout-run:${att.eventId}`]);
    expect(detail.payouts[0]).toMatchObject({ simulated: true });
    expect(detail.payouts[0]!.receipt).not.toBeNull();
  });

  it('on a test network, the demo button pays over Lightning from the test payer wallet', async () => {
    const db = memoryDb();
    const t = settableClock('2026-11-19T12:00:00Z');
    const seed = '66'.repeat(32);
    const fakePool = new FakeWallet({ db, seed, account: 'pool', clock: t.clock });
    // an NWC wallet holding test sats: real payments, so not "simulated"
    const pool: Wallet = {
      kind: 'nwc',
      simulated: false,
      makeInvoice: (a, m, e) => fakePool.makeInvoice(a, m, e),
      payInvoice: (i) => fakePool.payInvoice(i),
      lookupInvoice: (h) => fakePool.lookupInvoice(h),
      getBalanceSat: () => fakePool.getBalanceSat(),
    };
    const payer = new FakeWallet({ db, seed, account: 'payer', clock: t.clock, openingSat: 1e6 });
    const config = loadConfig({
      ...SECRETS,
      DATABASE_PATH: '/nonexistent/ndox.sqlite',
      SEED_DIR: DEFAULT_PATHS.seedDir,
    });
    const services = createServices(config, db, silentLog, {
      clock: t.clock,
      liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
      publisher: null,
      priceFetch,
      wallet: pool,
      testFunds: true,
      testPayer: payer,
    });
    const s = { app: await buildApp({ services }), services, t, db };

    expect((await s.app.inject('/api/meta')).json()).toMatchObject({
      testFunds: true,
      demoPay: 'test',
    });
    expect((await s.app.inject('/api/pool')).json()).toMatchObject({
      wallet: { kind: 'nwc', simulated: false, testFunds: true },
    });
    const inv = await sponsor(s, { amountFcfa: 1000 });
    expect(inv).toMatchObject({ status: 'pending', simulated: false, testFunds: true });

    const res = await simulate(s, inv.paymentHash);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid', simulated: false, testFunds: true });
    expect(await payer.getBalanceSat()).toBe(1e6 - inv.amountSat);
    expect(await pool.getBalanceSat()).toBe(inv.amountSat);
    // a second press is harmless: no second payment
    expect((await simulate(s, inv.paymentHash)).json()).toMatchObject({ status: 'paid' });
    expect(await payer.getBalanceSat()).toBe(1e6 - inv.amountSat);

    // a payer that cannot pay is reported, not hidden
    const broke = await sponsor(s, { amountFcfa: 1000 });
    services.money.testPayer = {
      kind: 'nwc',
      simulated: false,
      makeInvoice: (a, m, e) => payer.makeInvoice(a, m, e),
      payInvoice: () => Promise.reject(new Error('insufficient balance')),
      lookupInvoice: (h) => payer.lookupInvoice(h),
      getBalanceSat: () => payer.getBalanceSat(),
    };
    const fail = await simulate(s, broke.paymentHash);
    expect(fail.statusCode).toBe(502);
    expect(fail.json()).toEqual({ error: 'test_payment_failed' });
  });

  it('has no "simulate payment" endpoint with a real wallet', async () => {
    const real: Wallet = {
      kind: 'nwc',
      simulated: false,
      makeInvoice: () => Promise.reject(new Error('offline')),
      payInvoice: () => Promise.reject(new Error('offline')),
      lookupInvoice: () => Promise.resolve({ paid: false, state: 'not_found' }),
      getBalanceSat: () => Promise.reject(new Error('offline')),
    };
    const s = await setup({ wallet: real });
    const res = await simulate(s, '0'.repeat(64));
    expect(res.statusCode).toBe(404);
    const pool = (await s.app.inject('/api/pool')).json();
    expect(pool).toMatchObject({ wallet: { simulated: false }, balanceSat: null });
    const inv = await s.app.inject({
      method: 'POST',
      url: '/api/sponsor/invoice',
      payload: { amountFcfa: 1000 },
    });
    expect(inv.statusCode).toBe(503);
    expect(inv.json()).toEqual({ error: 'wallet_unavailable' });
  });
});
