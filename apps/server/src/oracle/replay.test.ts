import { getPublicKey, getTag, parseAttestation, type NostrEvent } from '@ndox/oracle';
import { describe, expect, it } from 'vitest';
import { replayRuns } from '../db/schema.js';
import { silentLog } from '../lib/log.js';
import { DEFAULT_PATHS } from '../paths.js';
import { memoryDb, StubSource, TEST_DEMO_SECRET } from '../test/helpers.js';
import { SeedSource } from '../wave/source.js';
import { getAnnouncement, getAttestation } from './jobs.js';
import { runReplay, type ReplayDeps } from './replay.js';

function deps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    db: memoryDb(),
    demoSecret: TEST_DEMO_SECRET,
    source: new SeedSource(DEFAULT_PATHS.seedDir),
    publisher: null,
    relays: ['wss://relay.example'],
    log: silentLog,
    now: () => new Date('2026-11-19T12:00:00Z'),
    ...overrides,
  };
}

describe('runReplay (seed data)', () => {
  it('replays Kayar 2026-02-27 end to end: both models cross 2.5 m → danger, verified', async () => {
    const d = deps();
    const r = await runReplay(d, 'kayar', '2026-02-27');
    expect(r.outcome).toBe('danger');
    expect(r.decisiveM).toBe(2.62);
    expect(r.verification.ok).toBe(true);
    expect(r.eventId).toBe(`ndox-replay:kayar:2026-02-27:${r.runId}`);
    expect(r.steps.map((s) => [s.step, s.at])).toEqual([
      ['announce', '2026-02-26T20:00:00Z'],
      ['fetch', '2026-02-27T05:00:00Z'],
      ['attest', '2026-02-27T05:15:00Z'],
    ]);

    const ann = JSON.parse(getAnnouncement(d.db, r.eventId)?.eventJson ?? '') as NostrEvent;
    const att = JSON.parse(getAttestation(d.db, r.eventId)?.eventJson ?? '') as NostrEvent;
    for (const e of [ann, att]) {
      expect(getTag(e, 't')).toBe('ndox-replay');
      expect(e.pubkey).toBe(getPublicKey(TEST_DEMO_SECRET));
    }
    // honest provenance: the archive fetch time, not a backdated one
    const content = parseAttestation(att).content;
    expect(content.data.fetchedAt).toMatch(/^2026-11-19T/);
    expect(content.data.models.map((m) => [m.id, m.windowMaxM, m.validHours])).toEqual([
      ['ecmwf_wam', 2.86, 12],
      ['ncep_gfswave025', 2.62, 12],
    ]);
    expect(d.db.select().from(replayRuns).get()).toMatchObject({ id: r.runId, status: 'done' });
  });

  it('replays 2026-02-05 at Kayar honestly as "calme" (alert day the index missed)', async () => {
    const r = await runReplay(deps(), 'kayar', '2026-02-05');
    expect(r.outcome).toBe('calme');
    expect(r.decisiveM).toBe(1.9);
    expect(r.verification.ok).toBe(true);
  });

  it('gives each run fresh event ids and nonces', async () => {
    const d = deps();
    const a = await runReplay(d, 'kayar', '2026-02-27');
    const b = await runReplay(d, 'kayar', '2026-02-27');
    expect(a.runId).not.toBe(b.runId);
    expect(a.eventId).not.toBe(b.eventId);
    expect(getAnnouncement(d.db, a.eventId)?.noncePoint).not.toBe(
      getAnnouncement(d.db, b.eventId)?.noncePoint,
    );
  });

  it('attests "indisponible" when no data can be found', async () => {
    const r = await runReplay(
      deps({ source: new StubSource(() => new Error('offline')) }),
      'joal',
      '2026-02-27',
    );
    expect(r.outcome).toBe('indisponible');
    expect(r.verification.ok).toBe(true);
  });

  it('refuses today, future days, unknown sites and bad dates', async () => {
    const d = deps();
    await expect(runReplay(d, 'kayar', '2026-11-19')).rejects.toThrow(/past/);
    await expect(runReplay(d, 'kayar', '2027-01-01')).rejects.toThrow(/past/);
    await expect(runReplay(d, 'dakar', '2026-02-27')).rejects.toThrow(/unknown site/);
    await expect(runReplay(d, 'kayar', '2026-13-01')).rejects.toThrow(/invalid date/);
  });
});
