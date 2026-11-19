import { parseAttestation, type NostrEvent } from '@ndox/oracle';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { silentLog } from '../lib/log.js';
import { announce, attest, fetchForecasts } from '../oracle/jobs.js';
import { runReplay } from '../oracle/replay.js';
import { DEFAULT_PATHS } from '../paths.js';
import { createServices } from '../services.js';
import { envelope, marineBody, memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { SeedSource } from '../wave/source.js';

const SECRETS = {
  ORACLE_SECRET: '11'.repeat(32),
  DEMO_ORACLE_SECRET: '22'.repeat(32),
  POOL_SECRET: '33'.repeat(32),
  SESSION_SECRET: '44'.repeat(32),
  PII_ENCRYPTION_KEY: '55'.repeat(32),
};

async function setup(source = StubSource.constant({ ecmwf_wam: 2.9, ncep_gfswave025: 2.7 })) {
  const config = loadConfig({
    ...SECRETS,
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
  });
  const db = memoryDb();
  const t = settableClock('2026-02-26T20:00:00Z');
  const services = createServices(config, db, silentLog, {
    clock: t.clock,
    liveSource: source,
    publisher: null,
  });
  services.replay.source = new SeedSource(DEFAULT_PATHS.seedDir);
  const app = await buildApp({ services });
  return { app, services, t, db };
}

async function liveDay(s: Awaited<ReturnType<typeof setup>>, site = 'kayar', date = '2026-02-27') {
  await announce(s.services.live, site, date);
  s.t.set(`${date}T05:00:00Z`);
  await fetchForecasts(s.services.live, site, date);
  s.t.set(`${date}T05:15:00Z`);
  return attest(s.services.live, site, date);
}

describe('public API', () => {
  it('GET /api/meta exposes public keys only', async () => {
    const s = await setup();
    const res = await s.app.inject('/api/meta');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      oraclePubkey: string;
      demoOraclePubkey: string;
      nostrPublish: boolean;
    }>();
    expect(body.oraclePubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.demoOraclePubkey).not.toBe(body.oraclePubkey);
    expect(body.nostrPublish).toBe(false);
    for (const secret of Object.values(SECRETS)) expect(res.body).not.toContain(secret);
  });

  it('GET /api/sites lists the four sites with their thresholds and season', async () => {
    const s = await setup();
    const sites = (await s.app.inject('/api/sites')).json<
      { id: string; thresholdM: number; inSeason: boolean }[]
    >();
    expect(sites.map((x) => x.id)).toEqual(['kayar', 'saint-louis', 'joal', 'soumbedioune']);
    expect(sites.every((x) => x.thresholdM === 2.5 && x.inSeason)).toBe(true);
  });

  it('GET /api/today shows the commitment, then the attested outcome', async () => {
    const s = await setup();
    await announce(s.services.live, 'kayar', '2026-02-27');
    s.t.set('2026-02-27T04:00:00Z');
    type Today = {
      date: string;
      sites: {
        id: string;
        announcement: { attestAt: string } | null;
        attestation: { outcome: string; models: unknown[] } | null;
      }[];
    };
    let today = (await s.app.inject('/api/today')).json<Today>();
    expect(today.date).toBe('2026-02-27');
    expect(today.sites[0]?.announcement?.attestAt).toBe('2026-02-27T05:15:00Z');
    expect(today.sites[0]?.attestation).toBeNull();
    expect(today.sites[1]?.announcement).toBeNull();

    await liveDay(s);
    today = (await s.app.inject('/api/today')).json<Today>();
    expect(today.sites[0]?.attestation).toMatchObject({
      outcome: 'danger',
      models: [
        { id: 'ecmwf_wam', windowMaxM: 2.9, validHours: 12 },
        { id: 'ncep_gfswave025', windowMaxM: 2.7, validHours: 12 },
      ],
    });
  });

  it('GET /api/attestations separates live from replays and validates its query', async () => {
    const s = await setup();
    await liveDay(s);
    await runReplay(s.services.replay, 'kayar', '2026-02-05');
    const live = (await s.app.inject('/api/attestations')).json<{
      items: { eventId: string; replay: boolean }[];
    }>();
    expect(live.items.map((i) => i.eventId)).toEqual(['ndox:kayar:2026-02-27']);
    const replays = (await s.app.inject('/api/attestations?replay=1')).json<{
      items: { replay: boolean; outcome: string }[];
    }>();
    expect(replays.items).toHaveLength(1);
    expect(replays.items[0]).toMatchObject({ replay: true, outcome: 'calme' });
    expect((await s.app.inject('/api/attestations?site=joal')).json()).toEqual({ items: [] });
    expect((await s.app.inject('/api/attestations?limit=0')).statusCode).toBe(400);
    expect((await s.app.inject('/api/attestations?site=atlantis')).statusCode).toBe(400);
  });

  it('GET /api/attestations/:eventId returns everything a verifier needs, and raw bodies hash to the published values', async () => {
    const s = await setup();
    await liveDay(s);
    const res = await s.app.inject('/api/attestations/ndox:kayar:2026-02-27');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      announcement: { event: NostrEvent };
      attestation: { event: NostrEvent; outcome: string };
      forecasts: { model: string; rawUrl: string; sha256: string }[];
      payouts: unknown[];
    }>();
    expect(body.attestation.outcome).toBe('danger');
    expect(body.payouts).toEqual([]);
    const published = parseAttestation(body.attestation.event).content.data.models;
    for (const f of body.forecasts) {
      const raw = await s.app.inject(f.rawUrl);
      expect(raw.statusCode).toBe(200);
      const hash = createHash('sha256').update(raw.rawPayload).digest('hex');
      expect(hash).toBe(published.find((m) => m.id === f.model)?.sha256);
      expect(raw.headers['x-content-sha256']).toBe(hash);
    }
    expect((await s.app.inject('/api/attestations/ndox:kayar:2026-02-28')).statusCode).toBe(404);
    expect(
      (await s.app.inject('/api/attestations/ndox:kayar:2026-02-27/raw/nope')).statusCode,
    ).toBe(404);
    expect((await s.app.inject('/api/attestations/not-an-id')).statusCode).toBe(400);
  });

  it('GET /api/forecast/:site gives a 7-day outlook with the same rule (not attested)', async () => {
    const source = new StubSource((q) =>
      envelope(
        q,
        marineBody(q, (date, h) => (h === 10 ? (date === '2026-02-28' ? 3.1 : 1.2) : 0.8)),
      ),
    );
    const s = await setup(source);
    s.t.set('2026-02-27T09:00:00Z');
    const res = await s.app.inject('/api/forecast/kayar');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      attested: boolean;
      days: { date: string; outcome: string; decisiveM: number }[];
    }>();
    expect(body.attested).toBe(false);
    expect(body.days).toHaveLength(7);
    expect(body.days.slice(0, 3).map((d) => [d.date, d.outcome, d.decisiveM])).toEqual([
      ['2026-02-27', 'calme', 1.2],
      ['2026-02-28', 'danger', 3.1],
      ['2026-03-01', 'calme', 1.2],
    ]);
    // cached: no new upstream calls
    const calls = source.calls.length;
    await s.app.inject('/api/forecast/kayar');
    expect(source.calls.length).toBe(calls);
    expect((await s.app.inject('/api/forecast/atlantis')).statusCode).toBe(400);
  });

  it('GET /api/forecast/:site answers 503 when the models are unreachable', async () => {
    const s = await setup(new StubSource(() => new Error('offline')));
    const res = await s.app.inject('/api/forecast/joal');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'forecast_unavailable' });
  });

  it('GET /api/backtest serves the committed backtest', async () => {
    const s = await setup();
    const res = await s.app.inject('/api/backtest');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sites: unknown[] }>().sites.length).toBe(4);
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const s = await setup();
    const res = await s.app.inject('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});
