import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { seedDemo } from '../admin/seed.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { silentLog } from '../lib/log.js';
import { derivedAdminPassword, hashPassword } from '../lib/password.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { DEFAULT_PATHS } from '../paths.js';
import { runPayoutJobs } from '../payouts/engine.js';
import { createServices, type ServiceOverrides } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { FakeLnAddressResolver, FakeWallet } from '../wallet/fake.js';
import type { TestFaucet } from '../wallet/faucet.js';
import type { LnAddressResolver, Wallet } from '../wallet/types.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};
const PASSWORD = derivedAdminPassword(SECRETS.SESSION_SECRET);
const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

/** Lets a test break crews' Lightning addresses, then repair them. */
class SwitchResolver implements LnAddressResolver {
  broken = false;
  inner: LnAddressResolver | null = null;
  requestInvoice(address: string, amountSat: number, comment?: string) {
    if (this.broken)
      return Promise.reject(new Error(`LNURL error for ${address}: lnbc1qqqqqqqqqqqq expired`));
    return this.inner!.requestInvoice(address, amountSat, comment);
  }
}

async function setup(
  env: Record<string, string> = {},
  fetchPrice: typeof fetch = priceFetch,
  overrides: (db: ReturnType<typeof memoryDb>, clock: () => Date) => ServiceOverrides = () => ({}),
) {
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
    PUBLIC_BASE_URL: 'https://ndox.example.com',
    NODE_ENV: 'production',
    ...env,
  });
  const db = memoryDb();
  const t = settableClock('2026-11-19T12:00:00Z');
  const resolver = new SwitchResolver();
  const services = createServices(config, db, silentLog, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
    publisher: null,
    priceFetch: fetchPrice,
    resolver,
    ...overrides(db, t.clock),
  });
  resolver.inner = new FakeLnAddressResolver({
    db,
    seed: services.replayPayouts.fakeSeed,
    clock: t.clock,
  });
  const app = await buildApp({ services });
  return { app, services, t, db, resolver };
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(app: FastifyInstance, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } });
  expect(res.statusCode).toBe(200);
  const setCookie = String(res.headers['set-cookie']);
  return {
    cookie: setCookie.split(';')[0]!,
    csrf: res.json<{ csrfToken: string }>().csrfToken,
  };
}

function client(app: FastifyInstance, s: Session) {
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: s.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': s.csrf }),
      },
      ...(payload ? { payload } : {}),
    });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: object = {}) => call('POST', url, payload),
    put: (url: string, payload: object) => call('PUT', url, payload),
    patch: (url: string, payload: object) => call('PATCH', url, payload),
  };
}

describe('admin API: authentication', () => {
  it('logs in with the derived password, sets a hardened cookie, and logs out', async () => {
    const { app } = await setup();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: PASSWORD },
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^ndox_admin=[A-Za-z0-9_-]{43}; /);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/api/admin', 'Secure'])
      expect(cookie).toContain(flag);

    const s = await login(app);
    const c = client(app, s);
    expect((await c.get('/api/admin/session')).json()).toMatchObject({
      csrfToken: s.csrf,
      wallet: { kind: 'fake', simulated: true },
    });
    expect((await c.post('/api/admin/logout')).statusCode).toBe(204);
    expect((await c.get('/api/admin/session')).statusCode).toBe(401);
  });

  it('refuses requests without a session, without the CSRF token, or from another origin', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/admin/crews')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/crews',
          headers: { cookie: 'ndox_admin=forged' },
        })
      ).statusCode,
    ).toBe(401);
    const s = await login(app);
    const body = { site: 'kayar', lnAddress: 'k1@demo.ndox.invalid' };
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/admin/crews',
      headers: { cookie: s.cookie },
      payload: body,
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await app.inject({
      method: 'POST',
      url: '/api/admin/crews',
      headers: { cookie: s.cookie, 'x-csrf-token': 'x'.repeat(43) },
      payload: body,
    });
    expect(wrongCsrf.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/admin/crews',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://evil.example' },
      payload: body,
    });
    expect(crossSite.statusCode).toBe(403);
    const sameSite = await app.inject({
      method: 'POST',
      url: '/api/admin/crews',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://ndox.example.com' },
      payload: body,
    });
    expect(sameSite.statusCode).toBe(201);
    const loginCrossSite = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      headers: { origin: 'https://evil.example' },
      payload: { password: PASSWORD },
    });
    expect(loginCrossSite.statusCode).toBe(403);
  });

  it('rate-limits login attempts', async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/admin/login',
            payload: { password: `guess-${i}` },
          })
        ).statusCode,
      ).toBe(401);
    const limited = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: PASSWORD },
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('uses ADMIN_PASSWORD_HASH when set (and the derived password no longer works)', async () => {
    const hash = await hashPassword('a long treasurer passphrase', 14);
    const { app } = await setup({ ADMIN_PASSWORD_HASH: hash });
    await login(app, 'a long treasurer passphrase');
    const old = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: PASSWORD },
    });
    expect(old.statusCode).toBe(401);
  });

  it('refuses to start with a malformed ADMIN_PASSWORD_HASH', () => {
    expect(() =>
      loadConfig({
        ...SECRETS,
        DATABASE_PATH: '/nonexistent/ndox.sqlite',
        ADMIN_PASSWORD_HASH: 'hunter2',
      }),
    ).toThrow(/ADMIN_PASSWORD_HASH/);
  });
});

describe('admin API: crews, policies, deposits, settings', () => {
  it('enrols a crew without echoing personal data, then covers it with a premium', async () => {
    const { app } = await setup();
    const c = client(app, await login(app));
    const bad = await c.post('/api/admin/crews', { site: 'kayar', lnAddress: 'not an address' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid', message: 'invalid Lightning address' });

    const res = await c.post('/api/admin/crews', {
      site: 'kayar',
      lnAddress: 'Moussa.Diop@wallet.example',
      phone: '+221 77 123 45 67',
    });
    expect(res.statusCode).toBe(201);
    const crew = res.json<{ id: string; pseudonym: string }>();
    expect(crew).toMatchObject({
      pseudonym: 'Pirogue K-01',
      demo: true,
      active: true,
      lnAddressHint: '•••@wallet.example',
      phoneHint: '•• 67',
      policy: null,
    });
    const list = await c.get('/api/admin/crews');
    expect(list.body).not.toMatch(/moussa|123 ?45|771234/i);

    const pol = await c.post('/api/admin/policies', { crewId: crew.id, weeks: 2 });
    expect(pol.statusCode).toBe(201);
    const { policy, deposit } = pol.json<{
      policy: { id: string; state: string; premiumFcfa: number };
      deposit: { paymentHash: string; invoice: string; amountFcfa: number; status: string };
    }>();
    expect(policy.state).toBe('awaiting_premium');
    expect(deposit).toMatchObject({ status: 'pending', amountFcfa: policy.premiumFcfa });
    expect(deposit.invoice).toMatch(/^lnbcrt/);

    const paid = await c.post(`/api/admin/deposits/${deposit.paymentHash}/simulate`);
    expect(paid.json()).toMatchObject({ status: 'paid', invoice: null, simulated: true });
    const after = (await c.get('/api/admin/crews')).json<{
      items: { policy: { state: string; activeFrom: string; activeUntil: string } }[];
    }>();
    expect(after.items[0]!.policy).toMatchObject({
      state: 'waiting',
      activeFrom: '2026-11-22T12:00:00Z',
      activeUntil: '2026-12-06T12:00:00Z',
    });

    const off = await c.patch(`/api/admin/crews/${crew.id}`, { active: false });
    expect(off.json()).toMatchObject({ active: false });
    expect((await c.patch('/api/admin/crews/c000000000000', { active: true })).statusCode).toBe(
      404,
    );
    const pol2 = await c.post('/api/admin/policies', { crewId: crew.id });
    expect(pol2.statusCode).toBe(400);
    expect(pol2.json()).toEqual({ error: 'inactive_crew' });
  });

  it('records a levy deposit into the pool', async () => {
    const { app } = await setup();
    const c = client(app, await login(app));
    expect((await c.post('/api/admin/deposits', { kind: 'levy', amountFcfa: 10 })).json()).toEqual({
      error: 'invalid_amount',
    });
    const levy = await c.post('/api/admin/deposits', { kind: 'levy', amountFcfa: 20_000 });
    expect(levy.statusCode).toBe(201);
    const d = levy.json<{ paymentHash: string; amountSat: number }>();
    await c.post(`/api/admin/deposits/${d.paymentHash}/simulate`);
    expect((await c.get(`/api/admin/deposits/${d.paymentHash}`)).json()).toMatchObject({
      status: 'paid',
      kind: 'levy',
    });
    const pool = (await app.inject('/api/pool')).json<{ balanceSat: number; deposits: object }>();
    expect(pool.balanceSat).toBe(d.amountSat);
    expect(pool.deposits).toMatchObject({ levy: d.amountSat });
    expect((await c.get('/api/admin/deposits')).json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('reads and changes settings, refusing out-of-range values', async () => {
    const { app, services } = await setup();
    const c = client(app, await login(app));
    expect((await c.get('/api/admin/settings')).json()).toMatchObject({
      policy: { payoutFcfa: 2000, waitingHours: 72 },
      sites: expect.arrayContaining([expect.objectContaining({ id: 'kayar', thresholdM: 2.5 })]),
    });
    expect((await c.put('/api/admin/settings', { policy: { payoutFcfa: 1 } })).statusCode).toBe(
      400,
    );
    expect(
      (await c.put('/api/admin/settings', { sites: [{ id: 'atlantis', thresholdM: 2 }] }))
        .statusCode,
    ).toBe(400);
    const res = await c.put('/api/admin/settings', {
      policy: { payoutFcfa: 2500, dailyPayoutCapSats: 30_000 },
      sites: [{ id: 'joal', thresholdM: 2.8 }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      policy: { payoutFcfa: 2500, dailyPayoutCapSats: 30_000, waitingHours: 72 },
      sites: expect.arrayContaining([expect.objectContaining({ id: 'joal', thresholdM: 2.8 })]),
    });
    expect(services.settings().payoutFcfa).toBe(2500);
  });

  it('has no "simulate payment" endpoint with a real wallet', async () => {
    const hash = await hashPassword('a long treasurer passphrase', 14);
    const { app } = await setup({
      WALLET_MODE: 'nwc',
      NWC_URL:
        'nostr+walletconnect://' +
        'ab'.repeat(32) +
        '?relay=wss://relay.invalid&secret=' +
        '66'.repeat(32),
      ADMIN_PASSWORD_HASH: hash,
    });
    const c = client(app, await login(app, 'a long treasurer passphrase'));
    expect((await c.post(`/api/admin/deposits/${'0'.repeat(64)}/simulate`)).statusCode).toBe(404);
    const crew = await c.post('/api/admin/crews', { site: 'joal', lnAddress: 'a@b.example' });
    expect(crew.json()).toMatchObject({ demo: false });
  });
});

describe('admin API: payouts, alerts, replay', () => {
  it('shows a failed payout as an alert, and a retry pays it exactly once', async () => {
    const { app, services, t, resolver } = await setup();
    const c = client(app, await login(app));
    const levy = (await c.post('/api/admin/deposits', { kind: 'levy', amountFcfa: 50_000 })).json<{
      paymentHash: string;
    }>();
    await c.post(`/api/admin/deposits/${levy.paymentHash}/simulate`);
    await seedDemo(services, { perSite: 1 });

    resolver.broken = true;
    t.set('2026-11-22T20:00:00Z');
    await announce(services.live, 'kayar', '2026-11-23');
    t.set('2026-11-23T05:00:00Z');
    await fetchForecasts(services.live, 'kayar', '2026-11-23');
    t.set('2026-11-23T05:15:00Z');
    await attest(services.live, 'kayar', '2026-11-23');
    for (let i = 0; i < 6; i++) {
      t.set(`2026-11-23T${String(6 + i).padStart(2, '0')}:00:00Z`);
      await runPayoutJobs(services.money);
    }
    const failed = (await c.get('/api/admin/payouts?status=failed')).json<{
      items: { id: string; crew: string; attempts: number; error: string }[];
    }>();
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]).toMatchObject({ crew: 'Pirogue K-01', attempts: 5 });
    expect(failed.items[0]!.error).not.toMatch(/kayar-01|lnbc1q/);

    const alerts = (await c.get('/api/admin/alerts')).json<{
      alerts: { code: string; level: string; detail: Record<string, unknown> }[];
    }>();
    expect(alerts.alerts[0]).toMatchObject({
      level: 'error',
      code: 'payout_failed',
      detail: { crew: 'Pirogue K-01', site: 'kayar', attempts: 5 },
    });
    expect(JSON.stringify(alerts)).not.toMatch(/demo\.ndox\.invalid/);

    resolver.broken = false;
    const id = failed.items[0]!.id;
    const retry = await c.post(`/api/admin/payouts/${id}/retry`);
    expect(retry.json()).toMatchObject({ id, step: 'paid', status: 'paid' });
    expect((await c.post(`/api/admin/payouts/${id}/retry`)).statusCode).toBe(409);
    expect((await c.get('/api/admin/alerts')).body).not.toContain('payout_failed');
  });

  it('replays a past danger day and pays the demo crews from a simulated wallet', async () => {
    const { app, services } = await setup();
    const c = client(app, await login(app));
    const levy = (await c.post('/api/admin/deposits', { kind: 'levy', amountFcfa: 50_000 })).json<{
      paymentHash: string;
    }>();
    await c.post(`/api/admin/deposits/${levy.paymentHash}/simulate`);
    await seedDemo(services, { perSite: 2 });

    expect(
      (await c.post('/api/admin/replay', { site: 'kayar', date: '2027-01-01' })).json(),
    ).toEqual({ error: 'not_past' });
    const res = await c.post('/api/admin/replay', { site: 'kayar', date: '2026-02-27' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      replay: { outcome: string; verification: { ok: boolean }; steps: unknown[] };
      payouts: {
        simulated: boolean;
        paid: number;
        policies: number;
        payouts: { pseudonym: string }[];
      };
    }>();
    expect(body.replay).toMatchObject({ outcome: 'danger', verification: { ok: true } });
    expect(body.replay.steps).toHaveLength(3);
    expect(body.payouts).toMatchObject({ simulated: true, policies: 2, paid: 2 });
    expect(body.payouts.payouts.map((p) => p.pseudonym)).toEqual(['Pirogue K-01', 'Pirogue K-02']);
    // the live pool is untouched by a replay
    expect((await c.get('/api/admin/payouts')).json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});

describe('alerts', () => {
  it('flags a stale price and a pool that cannot cover a bad week', async () => {
    const offline = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const { app, services } = await setup({}, offline);
    const c = client(app, await login(app));
    await seedDemo(services, { perSite: 1, poolFcfa: 1000 });
    const alerts = (await c.get('/api/admin/alerts')).json<{
      alerts: { code: string; level: string; detail: Record<string, unknown> }[];
    }>().alerts;
    expect(alerts.map((a) => a.code).sort()).toEqual(['low_coverage', 'price_stale']);
    expect(alerts.find((a) => a.code === 'price_stale')!.detail).toEqual({ source: 'seed' });
  });
});

describe('seedDemo', () => {
  it('tops sites up to N demo crews with cover active now, idempotently', async () => {
    const { services } = await setup();
    const r = await seedDemo(services, { perSite: 2, weeks: 4, poolFcfa: 10_000 });
    expect(r).toMatchObject({ enrolled: 8, covered: 8, simulated: true });
    expect(r.premiumSat).toBeGreaterThan(0);
    // 10 000 FCFA = 26 312 sats; the deficit costs 10 001 whole FCFA = 26 314 sats
    expect(r.levySat).toBe(26_314);
    const snap = await (await import('../pool/stats.js')).poolSnapshot(services.money, 'mainnet');
    expect(snap.policies).toMatchObject({ covered: 8, waiting: 0 });
    expect(snap.balanceSat).toBe(r.premiumSat + r.levySat);
    expect(await seedDemo(services, { perSite: 2, poolFcfa: 10_000 })).toMatchObject({
      enrolled: 0,
      covered: 0,
      levySat: 0,
    });
  });
  it('seeds demo crews from the dashboard in the background, one run at a time', async () => {
    const { app } = await setup();
    const api = client(app, await login(app));
    expect((await api.post('/api/admin/seed-demo', { perSite: 99 })).statusCode).toBe(400);
    const started = await api.post('/api/admin/seed-demo', { perSite: 1, poolFcfa: 0 });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ running: true, error: null });
    let job = (await api.get('/api/admin/seed-demo')).json();
    for (let i = 0; job.running && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = (await api.get('/api/admin/seed-demo')).json();
    }
    expect(job).toMatchObject({
      running: false,
      error: null,
      result: { enrolled: 4, covered: 4, simulated: true },
    });
    const crewsRes = (await api.get('/api/admin/crews')).json<{ items: { demo: boolean }[] }>();
    expect(crewsRes.items.filter((c) => c.demo)).toHaveLength(4);
  });

  it('on a test network, gives demo crews faucet wallets and pays premiums over Lightning', async () => {
    const addresses: string[] = [];
    const faucet: TestFaucet = {
      createWallet: async () => {
        const lightningAddress = `nwc${addresses.length + 1}@faucet.example`;
        addresses.push(lightningAddress);
        return { lightningAddress };
      },
    };
    let payer: FakeWallet | undefined;
    let fakePool: FakeWallet | undefined;
    const { services } = await setup({}, priceFetch, (db, clock) => {
      const seed = '77'.repeat(32);
      fakePool = new FakeWallet({ db, seed, account: 'pool', clock });
      payer = new FakeWallet({ db, seed, account: 'payer', clock, openingSat: 1e7 });
      const pool: Wallet = {
        kind: 'nwc',
        simulated: false,
        makeInvoice: (a, m, e) => fakePool!.makeInvoice(a, m, e),
        payInvoice: (i) => fakePool!.payInvoice(i),
        lookupInvoice: (h) => fakePool!.lookupInvoice(h),
        getBalanceSat: () => fakePool!.getBalanceSat(),
      };
      return { wallet: pool, testFunds: true, testPayer: payer, faucet };
    });
    const r = await seedDemo(services, { perSite: 1, poolFcfa: 10_000 });
    expect(r).toMatchObject({ enrolled: 4, covered: 4, simulated: false });
    expect(addresses).toHaveLength(4);
    // every sat in the pool came from the test payer, over (fake) Lightning
    expect(await services.wallet.getBalanceSat()).toBe(r.premiumSat + r.levySat);
    expect(await payer!.getBalanceSat()).toBe(1e7 - r.premiumSat - r.levySat);
    const snap = await (await import('../pool/stats.js')).poolSnapshot(services.money, 'test');
    // a test-funds pool pays demo crews, so their cover is its exposure
    expect(snap.policies).toMatchObject({ covered: 4, waiting: 0 });
    expect(snap.wallet).toMatchObject({ kind: 'nwc', simulated: false, testFunds: true });
  });

  it('a run cut short after paying a premium is finished by the next run, never paid twice', async () => {
    let n = 0;
    const faucet: TestFaucet = {
      createWallet: async () => ({ lightningAddress: `nwc${++n}@faucet.example` }),
    };
    let payer: FakeWallet | undefined;
    let flaky = true;
    const { services, db } = await setup({}, priceFetch, (db, clock) => {
      const seed = '88'.repeat(32);
      const fakePool = new FakeWallet({ db, seed, account: 'pool', clock });
      payer = new FakeWallet({ db, seed, account: 'payer', clock, openingSat: 1e7 });
      const pool: Wallet = {
        kind: 'nwc',
        simulated: false,
        makeInvoice: (a, m, e) => fakePool.makeInvoice(a, m, e),
        payInvoice: (i) => fakePool.payInvoice(i),
        // the relay times out: the payment lands but the pool cannot confirm it yet
        lookupInvoice: (h) =>
          flaky ? Promise.reject(new Error('publish timeout')) : fakePool.lookupInvoice(h),
        getBalanceSat: () => fakePool.getBalanceSat(),
      };
      return { wallet: pool, testFunds: true, testPayer: payer, faucet };
    });
    const sleep = async () => {};
    await expect(seedDemo(services, { perSite: 1, sleep })).rejects.toThrow(/run seed-demo again/);
    const spentFirst = 1e7 - (await payer!.getBalanceSat());
    expect(spentFirst).toBeGreaterThan(0); // one premium went out

    flaky = false;
    const r = await seedDemo(services, { perSite: 1, sleep });
    expect(r).toMatchObject({ enrolled: 0, covered: 4 });
    // the payer paid each crew's premium exactly once
    expect(1e7 - (await payer!.getBalanceSat())).toBe(r.premiumSat);
    const { policies } = await import('../db/schema.js');
    expect(db.select().from(policies).all()).toHaveLength(4);
  });
});
