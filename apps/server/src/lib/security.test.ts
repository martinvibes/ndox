import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger, redactUrl } from '../logger.js';
import { notifyPayouts } from '../notify/jobs.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { DEFAULT_PATHS } from '../paths.js';
import { runPayoutJobs } from '../payouts/engine.js';
import { enrolCrew } from '../pool/crews.js';
import { createDeposit, refreshDeposit } from '../pool/deposits.js';
import { createPolicy } from '../pool/policies.js';
import { createServices } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import type { FakeWallet } from '../wallet/fake.js';
import type { Log } from './log.js';
import { CSP } from './security.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};
const PHONE = '+221771234567';
const LN = 'awa.ndiaye@demo.ndox.invalid';
const TOKEN = 'cb-token-0123456789abcdef';
const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

async function setup(baseUrl: string) {
  const lines: string[] = [];
  const capture: Log = {
    info: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
    warn: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
    error: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
  };
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
    PUBLIC_BASE_URL: baseUrl,
    NODE_ENV: 'production',
    AT_CALLBACK_TOKEN: TOKEN,
  });
  const db = memoryDb();
  const t = settableClock('2026-11-19T12:00:00Z');
  // no AT_API_KEY: SMS go to the console notifier, i.e. to this log
  const services = createServices(config, db, capture, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
    publisher: null,
    priceFetch,
  });
  const http = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const app = await buildApp({ services, logger: createLogger('info', http) });
  return { app, services, t, db, lines };
}

describe('security headers', () => {
  it('sends a strict CSP and the usual headers on pages and API answers; HSTS on https', async () => {
    const s = await setup('https://ndox.example.com');
    for (const url of ['/api/meta', '/e', '/healthz']) {
      const res = await s.app.inject({ url });
      expect(res.headers['content-security-policy']).toBe(`${CSP}; upgrade-insecure-requests`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers['referrer-policy']).toBeTruthy();
    }
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(CSP).toContain("frame-ancestors 'none'");
    // the crew page keeps its stricter referrer policy
    expect((await s.app.inject({ url: '/e' })).headers['referrer-policy']).toBe('no-referrer');

    const local = await setup('http://localhost:8080');
    const res = await local.app.inject({ url: '/api/meta' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(CSP);
  });
});

describe('logs', () => {
  it('redact secret query parameters', () => {
    expect(redactUrl('/api/ussd?token=abc&x=1')).toBe('/api/ussd?token=[redacted]&x=1');
    expect(redactUrl('/a?x=1&TOKEN=abc#f')).toBe('/a?x=1&TOKEN=[redacted]#f');
    expect(redactUrl('/api/today')).toBe('/api/today');
  });

  it('never contain a phone number, a Lightning address or the callback token (grep test)', async () => {
    const s = await setup('https://ndox.example.com');
    const pool = s.services.wallet as FakeWallet;
    const pay = async (hash: string) => {
      expect(pool.simulatePayment(hash)).toBe(true);
      await refreshDeposit(s.services.money, hash);
    };
    const levy = await createDeposit(s.services.money, { kind: 'levy', amountFcfa: 50_000 });
    await pay(levy.paymentHash!);
    const crew = enrolCrew(s.db, s.services.piiKey, {
      site: 'kayar',
      lnAddress: LN,
      phone: PHONE,
      demo: false,
    });
    const policy = createPolicy(s.db, {
      crewId: crew.id,
      fundedBy: 'crew',
      weeks: 1,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1000,
    });
    const premium = await createDeposit(s.services.money, { kind: 'premium', policyId: policy.id });
    await pay(premium.paymentHash!);

    s.t.set('2026-11-22T20:00:00Z');
    await announce(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T05:00:00Z');
    await fetchForecasts(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T05:15:00Z');
    await attest(s.services.live, 'kayar', '2026-11-23');
    s.t.set('2026-11-23T06:00:00Z');
    await runPayoutJobs(s.services.money);
    expect(await notifyPayouts(s.services.notify)).toEqual({ sent: 1, failed: 0 });

    for (const text of ['', '1', '2', '3'])
      await s.app.inject({
        method: 'POST',
        url: `/api/ussd?token=${TOKEN}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ sessionId: 's', phoneNumber: PHONE, text }).toString(),
      });
    await s.app.inject({ url: `/api/status/${crew.statusCode}` });
    await s.app.inject({ url: `/e/${crew.statusCode}` });

    const all = s.lines.join('\n');
    expect(all).toContain('incoming request'); // the HTTP log was captured
    expect(all).toMatch(/sms|SMS/); // and the SMS step logged something
    expect(all).not.toContain('771234567');
    expect(all).not.toContain('awa.ndiaye');
    expect(all).not.toContain('demo.ndox.invalid');
    expect(all).not.toContain(TOKEN);
  });
});
