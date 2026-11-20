import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { notifications } from '../db/schema.js';
import { silentLog } from '../lib/log.js';
import { notifyPayouts, MAX_ATTEMPTS } from '../notify/jobs.js';
import type { Notifier } from '../notify/sms.js';
import { USSD_MAX } from '../notify/ussd.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { DEFAULT_PATHS } from '../paths.js';
import { runPayoutJobs } from '../payouts/engine.js';
import { enrolCrew } from '../pool/crews.js';
import { createDeposit, refreshDeposit } from '../pool/deposits.js';
import { createPolicy } from '../pool/policies.js';
import { createServices } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import type { FakeWallet } from '../wallet/fake.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};
const PHONE = '+221771234567';
const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

/** Records every SMS; fails the first `failures` sends. */
class RecordingNotifier implements Notifier {
  readonly kind = 'africastalking' as const;
  readonly simulated = true;
  readonly sent: { to: string; message: string }[] = [];
  constructor(public failures = 0) {}
  async send(to: string, message: string) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('SMS provider answered 500');
    }
    this.sent.push({ to, message });
    return { providerId: `ATXid_${this.sent.length}`, simulated: true };
  }
}

async function setup(o: { env?: Record<string, string>; notifier?: RecordingNotifier } = {}) {
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
    PUBLIC_BASE_URL: 'https://ndox.example.com',
    NODE_ENV: 'production',
    ...o.env,
  });
  const db = memoryDb();
  const t = settableClock('2026-11-19T12:00:00Z');
  const notifier = o.notifier ?? new RecordingNotifier();
  const services = createServices(config, db, silentLog, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
    publisher: null,
    priceFetch,
    notifier,
  });
  const app = await buildApp({ services });
  const pool = services.wallet as FakeWallet;
  const pay = async (hash: string) => {
    expect(pool.simulatePayment(hash)).toBe(true);
    await refreshDeposit(services.money, hash);
  };

  // a funded pool and one covered crew that gave a phone number
  const levy = await createDeposit(services.money, { kind: 'levy', amountFcfa: 50_000 });
  await pay(levy.paymentHash!);
  const crew = enrolCrew(db, services.piiKey, {
    site: 'kayar',
    lnAddress: 'pecheur@demo.ndox.invalid',
    phone: PHONE,
    demo: false,
  });
  const policy = createPolicy(db, {
    crewId: crew.id,
    fundedBy: 'crew',
    weeks: 1,
    payoutFcfa: 2000,
    premiumWeeklyFcfa: 1000,
  });
  const premium = await createDeposit(services.money, { kind: 'premium', policyId: policy.id });
  await pay(premium.paymentHash!);
  return { app, services, t, db, notifier, crew };
}

/** A live danger day at Kayar on 2026-11-23, paid out at 06:00. */
async function dangerDay(s: Awaited<ReturnType<typeof setup>>) {
  s.t.set('2026-11-22T20:00:00Z');
  await announce(s.services.live, 'kayar', '2026-11-23');
  s.t.set('2026-11-23T05:00:00Z');
  await fetchForecasts(s.services.live, 'kayar', '2026-11-23');
  s.t.set('2026-11-23T05:15:00Z');
  await attest(s.services.live, 'kayar', '2026-11-23');
  s.t.set('2026-11-23T06:00:00Z');
  await runPayoutJobs(s.services.money);
}

const ussd = (s: Awaited<ReturnType<typeof setup>>, text: string, phone = PHONE, qs = '') =>
  s.app.inject({
    method: 'POST',
    url: `/api/ussd${qs}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      sessionId: 'ATUid_1',
      serviceCode: '*384*123#',
      phoneNumber: phone,
      text,
    }).toString(),
  });

describe('notify: SMS after a payout', () => {
  it('texts the paid crew once, in the brief’s format; a re-run sends nothing', async () => {
    const s = await setup();
    await dangerDay(s);
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 1, failed: 0 });
    expect(s.notifier.sent).toHaveLength(1);
    expect(s.notifier.sent[0]!.to).toBe(PHONE);
    expect(s.notifier.sent[0]!.message).toBe(
      `NDOX Kayar: mer dangereuse aujourd'hui (houle 2,7 m). 2 000 FCFA (TEST) envoyes. Restez a terre. Code: ${s.crew.statusCode}`,
    );
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 0, failed: 0 });
    // a day later the same payout is never texted again either
    s.t.set('2026-11-25T06:00:00Z');
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 0, failed: 0 });
    expect(s.notifier.sent).toHaveLength(1);
  });

  it(`retries a failed SMS on later ticks, at most ${MAX_ATTEMPTS} times`, async () => {
    const s = await setup({ notifier: new RecordingNotifier(2) });
    await dangerDay(s);
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 0, failed: 1 });
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 0, failed: 1 });
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 1, failed: 0 });
    const row = s.db.select().from(notifications).get()!;
    expect(row).toMatchObject({ status: 'sent', attempts: 3, providerId: 'ATXid_1' });

    const never = await setup({ notifier: new RecordingNotifier(99) });
    await dangerDay(never);
    for (let i = 0; i < 5; i++) await notifyPayouts(never.services.notify);
    expect(never.db.select().from(notifications).get()).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
    });
  });

  it('records delivery reports by provider id', async () => {
    const s = await setup();
    await dangerDay(s);
    await notifyPayouts(s.services.notify);
    const report = (id: string, status: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/sms/delivery',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ id, status, phoneNumber: PHONE }).toString(),
      });
    expect((await report('ATXid_1', 'Success')).json()).toEqual({ ok: true, known: true });
    expect((await report('ATXid_404', 'Success')).json()).toEqual({ ok: true, known: false });
    const row = s.db.select().from(notifications).get()!;
    expect(row).toMatchObject({ status: 'sent', deliveryStatus: 'Success' });
    await report('ATXid_1', 'Failed');
    expect(
      s.db.select().from(notifications).where(eq(notifications.id, row.id)).get(),
    ).toMatchObject({ status: 'failed' });
  });
});

describe('crew status: /api/status/:code and /e/:code', () => {
  it('shows cover and payouts by code, never the phone or the Lightning address', async () => {
    const s = await setup();
    await dangerDay(s);
    const code = s.crew.statusCode;
    const res = await s.app.inject({ url: `/api/status/${code.toLowerCase()}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      code,
      pseudonym: 'Pirogue K-01',
      site: 'kayar',
      demo: false,
      cover: { state: 'covered', payoutFcfa: 2000 },
      payouts: [{ date: '2026-11-23', amountFcfa: 2000, status: 'paid', simulated: true }],
    });
    expect(res.body).not.toMatch(/771234567|pecheur|demo\.ndox\.invalid/);
    expect((await s.app.inject({ url: '/api/status/K22222' })).statusCode).toBe(404);
    expect((await s.app.inject({ url: '/api/status/nope' })).statusCode).toBe(404);

    const page = await s.app.inject({ url: `/e/${code}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Pirogue K-01');
    expect(page.body).toContain('Couvert jusqu’au');
    expect(page.body).toContain(`/verifier/${encodeURIComponent('ndox:kayar:2026-11-23')}`);
    expect(page.body).not.toMatch(/771234567|pecheur|<script/);
    expect(page.body.length).toBeLessThan(30_000);

    const form = await s.app.inject({ url: `/e?code=${code.toLowerCase()}` });
    expect(form.statusCode).toBe(303);
    expect(form.headers.location).toBe(`/e/${code}`);
    expect((await s.app.inject({ url: '/e/K22222' })).statusCode).toBe(404);
    expect((await s.app.inject({ url: '/e' })).body).toContain('Mon équipage');
  });

  it('rate-limits code lookups', async () => {
    const s = await setup();
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await s.app.inject({ url: '/api/status/K22222' })).statusCode;
    expect(last).toBe(429);
  });

  it('behind one proxy (TRUST_PROXY=1), limits each visitor; a forged X-Forwarded-For does not help', async () => {
    const s = await setup({ env: { TRUST_PROXY: '1' } });
    const get = (xff: string) =>
      s.app.inject({ url: '/api/status/K22222', headers: { 'x-forwarded-for': xff } });
    for (let i = 0; i < 30; i++) expect((await get('203.0.113.7')).statusCode).toBe(404);
    expect((await get('203.0.113.7')).statusCode).toBe(429);
    // another visitor behind the same proxy is not affected
    expect((await get('198.51.100.9')).statusCode).toBe(404);
    // the proxy appends the real address: a forged first entry changes nothing
    expect((await get('10.9.9.9, 203.0.113.7')).statusCode).toBe(429);
  });

  it('without TRUST_PROXY, ignores X-Forwarded-For entirely', async () => {
    const s = await setup();
    for (let i = 0; i < 30; i++)
      await s.app.inject({
        url: '/api/status/K22222',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
    const res = await s.app.inject({
      url: '/api/status/K22222',
      headers: { 'x-forwarded-for': '10.0.0.99' },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe('USSD menu (Africa’s Talking format)', () => {
  it('answers the menu, the cover, the payouts and the sea, recognising the caller', async () => {
    const s = await setup();
    await dangerDay(s);
    const menu = await ussd(s, '');
    expect(menu.headers['content-type']).toContain('text/plain');
    expect(menu.body).toBe(
      "CON NDOX\n1. Statut de ma couverture\n2. Derniers paiements\n3. Mer aujourd'hui",
    );
    const cover = (await ussd(s, '1')).body;
    expect(cover).toMatch(/^END Pirogue K-01: couvert jusqu'au \d\d\/\d\d\. 2 000 FCFA/);
    expect(cover).toContain(s.crew.statusCode);
    expect((await ussd(s, '2')).body).toBe(
      'END Pirogue K-01, derniers paiements:\n23/11: 2 000 FCFA (simule)',
    );
    const sea = (await ussd(s, '3', '+221700000000')).body;
    expect(sea).toMatch(/^END Mer 23\/11:\nKayar: DANGER 2,7 m\n/);
    expect(sea).toContain('Joal-Fadiouth: resultat a 05:15 GMT');
    expect((await ussd(s, '1', '+221700000000')).body).toMatch(/^END Numero non inscrit/);
    expect((await ussd(s, '9')).body).toBe('END Choix invalide.');
    for (const t of ['', '1', '2', '3'])
      expect((await ussd(s, t)).body.length).toBeLessThanOrEqual(USSD_MAX);
  });

  it('requires the callback token when AT_CALLBACK_TOKEN is set', async () => {
    const token = 't0k3n'.repeat(4);
    const s = await setup({ env: { AT_CALLBACK_TOKEN: token } });
    expect((await ussd(s, '')).statusCode).toBe(403);
    expect((await ussd(s, '', PHONE, '?token=wrong')).statusCode).toBe(403);
    expect((await ussd(s, '', PHONE, `?token=${token}`)).statusCode).toBe(200);
  });
});
