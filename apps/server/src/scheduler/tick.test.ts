import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { announcements, attestations, forecasts, jobRuns, sites } from '../db/schema.js';
import { announce, getAttestation } from '../oracle/jobs.js';
import { makeCtx, memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { tick } from './tick.js';

function setup(
  start: string,
  heights: Record<string, number | Error> = { ecmwf_wam: 2.9, ncep_gfswave025: 2.7 },
) {
  const db = memoryDb();
  const t = settableClock(start);
  const source = StubSource.constant(heights);
  const ctx = makeCtx(db, { clock: t.clock, source });
  return { db, t, ctx, source, heights };
}

const summary = (r: Awaited<ReturnType<typeof tick>>) =>
  r.actions.map((a) => `${a.job}:${a.site}:${a.date}:${a.status}`);

describe('scheduler tick', () => {
  it('runs the daily loop at the scheduled times, once', async () => {
    const s = setup('2026-02-26T19:59:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);

    s.t.set('2026-02-26T20:00:00Z');
    expect(summary(await tick(s.ctx))).toEqual([
      'announce:kayar:2026-02-27:ok',
      'announce:saint-louis:2026-02-27:ok',
      'announce:joal:2026-02-27:ok',
      'announce:soumbedioune:2026-02-27:ok',
    ]);
    s.t.set('2026-02-26T20:01:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);

    s.t.set('2026-02-27T04:59:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);
    s.t.set('2026-02-27T05:00:00Z');
    expect(summary(await tick(s.ctx))).toEqual([
      'fetch:kayar:2026-02-27:ok',
      'fetch:saint-louis:2026-02-27:ok',
      'fetch:joal:2026-02-27:ok',
      'fetch:soumbedioune:2026-02-27:ok',
    ]);
    s.t.set('2026-02-27T05:14:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);
    s.t.set('2026-02-27T05:15:00Z');
    const attestTick = await tick(s.ctx);
    expect(summary(attestTick)).toEqual([
      'attest:kayar:2026-02-27:ok',
      'attest:saint-louis:2026-02-27:ok',
      'attest:joal:2026-02-27:ok',
      'attest:soumbedioune:2026-02-27:ok',
    ]);
    expect(attestTick.actions[0]?.detail).toBe('danger (2.7 m), published=false');
    s.t.set('2026-02-27T05:16:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);

    expect(s.db.select().from(attestations).all()).toHaveLength(4);
    expect(s.db.select().from(jobRuns).all()).toHaveLength(12);
  });

  it('catches up after downtime: late announcement before 05:15, fetch + attest together after', async () => {
    const s = setup('2026-02-27T03:00:00Z');
    expect(summary(await tick(s.ctx)).filter((a) => a.startsWith('announce:kayar'))).toEqual([
      'announce:kayar:2026-02-27:ok',
    ]);
    s.t.set('2026-02-27T07:30:00Z');
    expect(summary(await tick(s.ctx)).filter((a) => a.includes(':kayar:'))).toEqual([
      'fetch:kayar:2026-02-27:ok',
      'attest:kayar:2026-02-27:ok',
    ]);
  });

  it('does not announce after 05:15 for the same day, and gives up once the window closed', async () => {
    const s = setup('2026-02-27T05:15:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);
    expect(s.db.select().from(announcements).all()).toHaveLength(0);

    const s2 = setup('2026-02-26T21:00:00Z');
    await tick(s2.ctx);
    s2.t.set('2026-02-27T18:00:00Z');
    expect(summary(await tick(s2.ctx))).toEqual([]);
    expect(s2.db.select().from(attestations).all()).toHaveLength(0);
  });

  it('retries a failed fetch every 5 minutes until the attestation', async () => {
    const s = setup('2026-02-26T20:00:00Z', {
      ecmwf_wam: 2.9,
      ncep_gfswave025: new Error('HTTP 503'),
    });
    s.db.update(sites).set({ enabled: false }).run();
    s.db.update(sites).set({ enabled: true }).where(eq(sites.id, 'kayar')).run();
    await tick(s.ctx);

    s.t.set('2026-02-27T05:00:00Z');
    expect(summary(await tick(s.ctx))).toEqual(['fetch:kayar:2026-02-27:ok']);
    s.t.set('2026-02-27T05:04:00Z');
    expect(summary(await tick(s.ctx))).toEqual([]);
    s.heights.ncep_gfswave025 = 2.6;
    s.t.set('2026-02-27T05:05:00Z');
    expect(summary(await tick(s.ctx))).toEqual(['fetch:kayar:2026-02-27:ok']);
    expect(
      s.db
        .select()
        .from(forecasts)
        .all()
        .every((f) => f.status === 'ok'),
    ).toBe(true);
    s.t.set('2026-02-27T05:15:00Z');
    await tick(s.ctx);
    expect(getAttestation(s.db, 'ndox:kayar:2026-02-27')?.outcome).toBe('danger');
  });

  it('skips disabled sites and records failures without stopping other sites', async () => {
    const s = setup('2026-02-26T20:00:00Z');
    s.db.update(sites).set({ enabled: false }).where(eq(sites.id, 'joal')).run();
    // a broken row for kayar makes its announce fail; the other sites still run
    s.ctx.secret = 'ff'.repeat(32);
    const r = await tick(s.ctx);
    expect(r.actions.map((a) => a.site)).toEqual(['kayar', 'saint-louis', 'soumbedioune']);
    expect(r.actions.every((a) => a.status === 'error')).toBe(true);
    const runs = s.db.select().from(jobRuns).all();
    expect(runs.every((j) => j.status === 'error')).toBe(true);
    expect(runs[0]?.detail).not.toContain('ff'.repeat(32));
  });

  it('refuses to drive a replay context', async () => {
    const s = setup('2026-02-26T20:00:00Z');
    await announce(s.ctx, 'kayar', '2026-02-27');
    await expect(tick({ ...s.ctx, replayRunId: 'r1' })).rejects.toThrow(/live oracle only/);
  });
});
