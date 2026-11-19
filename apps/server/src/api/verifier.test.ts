/**
 * Contract test: the browser verifier (apps/web/src/verify) must accept what this API serves,
 * and reject it once tampered with.
 */
import { describe, expect, it } from 'vitest';
import type { AttestationDetail, Meta } from '../../../web/src/lib/api.js';
import {
  checkData,
  checkOracle,
  checkPayments,
  checkRelays,
  checkRule,
  parseDetail,
} from '../../../web/src/verify/checks.js';
import { runEquivocationDemo } from '../../../web/src/verify/equivocation.js';
import { seedDemo } from '../admin/seed.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { silentLog } from '../lib/log.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { runReplay } from '../oracle/replay.js';
import { DEFAULT_PATHS } from '../paths.js';
import { payReplay } from '../payouts/replay.js';
import { createServices } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { SeedSource } from '../wave/source.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};
const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

async function setup(now: string) {
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
  });
  const t = settableClock(now);
  const services = createServices(config, memoryDb(), silentLog, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 }),
    publisher: null,
    priceFetch,
  });
  services.replay.source = new SeedSource(DEFAULT_PATHS.seedDir);
  const app = await buildApp({ services });
  const get = async <T>(url: string) => (await app.inject(url)).json<T>();
  const fetchRaw = async (url: string) => {
    const res = await app.inject(url);
    if (res.statusCode !== 200) throw new Error(`raw ${res.statusCode}`);
    return res.body;
  };
  return { app, services, t, get, fetchRaw };
}

const noRelay = () => Promise.reject(new Error('must not query relays'));

describe('browser verifier against the API', () => {
  it('accepts a live attestation and rejects tampered copies', async () => {
    const s = await setup('2026-02-26T20:00:00Z');
    await announce(s.services.live, 'kayar', '2026-02-27');
    s.t.set('2026-02-27T05:00:00Z');
    await fetchForecasts(s.services.live, 'kayar', '2026-02-27');
    s.t.set('2026-02-27T05:15:00Z');
    await attest(s.services.live, 'kayar', '2026-02-27');

    const meta = await s.get<Meta>('/api/meta');
    const d = await s.get<AttestationDetail>('/api/attestations/ndox:kayar:2026-02-27');
    const p = parseDetail(d)!;
    const [nonce, sig] = checkOracle(d, meta);
    expect(nonce).toMatchObject({ state: 'ok', windowStart: '2026-02-27T06:00:00Z' });
    expect(sig).toMatchObject({ state: 'ok', oraclePubkey: meta.oraclePubkey, failed: [] });
    expect(checkRule(p)).toMatchObject({ state: 'ok', recomputed: 'danger' });
    expect(await checkData(d, p, s.fetchRaw)).toMatchObject({ state: 'ok', checked: 2 });
    expect(await checkRelays(d, meta, noRelay)).toMatchObject({ state: 'skip', reason: 'dry_run' });
    expect(checkPayments(d, meta.poolPubkey)).toMatchObject({ state: 'skip', total: 0 });

    // a different oracle key: refused
    expect(checkOracle(d, { ...meta, oraclePubkey: meta.demoOraclePubkey })[1]).toMatchObject({
      state: 'fail',
      failed: ['known_oracle'],
    });
    // the published outcome changed after signing: refused
    const forged = structuredClone(d);
    const c = JSON.parse(forged.attestation!.event.content) as { outcome: string };
    forged.attestation!.event.content = JSON.stringify({ ...c, outcome: 'calme' });
    expect(checkOracle(forged, meta)[1].state).toBe('fail');
    // an archived response that is not the one signed: refused
    const swapped = async (url: string) =>
      (await s.fetchRaw(url)).replace('"wave_height"', '"wave_height" ');
    expect(await checkData(d, p, swapped)).toMatchObject({ state: 'fail' });
  });

  it('checks the payment proofs of a replay paid to demo crews', async () => {
    const s = await setup('2026-11-19T12:00:00Z');
    await seedDemo(s.services, { perSite: 2, poolFcfa: 50_000 });
    const r = await runReplay(s.services.replay, 'kayar', '2026-02-27');
    const pay = await payReplay(s.services.money, r, s.services.replayPayouts);
    expect(pay.paid).toBe(2);

    const meta = await s.get<Meta>('/api/meta');
    const d = await s.get<AttestationDetail>(`/api/attestations/${r.eventId}`);
    expect(d.replay).toBe(true);
    expect(checkOracle(d, meta)[1]).toMatchObject({
      state: 'ok',
      oraclePubkey: meta.demoOraclePubkey,
    });
    expect(await checkRelays(d, meta, noRelay)).toEqual({
      id: 'relays',
      state: 'skip',
      reason: 'replay',
    });
    expect(checkPayments(d, meta.poolPubkey)).toEqual({
      id: 'payments',
      state: 'ok',
      valid: 2,
      total: 2,
    });
    const bad = structuredClone(d);
    bad.payouts[0]!.preimage = '00'.repeat(32);
    expect(checkPayments(bad, meta.poolPubkey)).toMatchObject({ state: 'fail', valid: 1 });
  });

  it('the equivocation demo recovers the throwaway key', () => {
    const demo = runEquivocationDemo();
    expect(demo.recovered).toBe(demo.secret);
    expect(demo.sigCalm.slice(0, 64)).toBe(demo.noncePoint);
    expect(demo.sigDanger.slice(0, 64)).toBe(demo.noncePoint);
    expect(demo.sigCalm).not.toBe(demo.sigDanger);
  });
});
