import { describe, expect, it } from 'vitest';
import { decideOutcome, evaluateTrigger, windowStats } from './trigger.js';

const WINDOW = { start: '2026-02-27T06:00:00Z', end: '2026-02-27T18:00:00Z' };

/** 24 hourly Open-Meteo timestamps for one day. */
const day = (d = '2026-02-27') =>
  Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`);

/** Values for 24 hours; `inWindow` fills hours 06–17. */
function series(inWindow: (number | null)[], outside: number | null = 9.9): (number | null)[] {
  const v: (number | null)[] = Array(24).fill(outside);
  inWindow.forEach((x, i) => (v[6 + i] = x));
  return v;
}

const RULE = { thresholdM: 2.5, minValidHours: 10, models: ['ecmwf_wam', 'ncep_gfswave025'] };

describe('windowStats', () => {
  it('takes the max over [06:00, 18:00) only', () => {
    const s = windowStats(day(), series([1, 2, 2.2, 1, 1, 1, 1, 1, 1, 1, 1, 1.5]), WINDOW);
    expect(s).toEqual({ windowMaxM: 2.2, validHours: 12 });
  });

  it('ignores the 18:00 hour (end is exclusive) and hours before 06:00', () => {
    const v = series(Array(12).fill(1));
    v[18] = 7;
    v[5] = 7;
    expect(windowStats(day(), v, WINDOW).windowMaxM).toBe(1);
  });

  it('counts only finite non-negative values as valid', () => {
    const s = windowStats(day(), series([1, null, 2, null, -1, 1, 1, 1, 1, 1, 1, 1]), WINDOW);
    expect(s.validHours).toBe(9);
    expect(s.windowMaxM).toBe(2);
  });

  it('treats an all-zero window as a land cell (no valid hours)', () => {
    const s = windowStats(day(), series(Array(12).fill(0)), WINDOW);
    expect(s).toEqual({ windowMaxM: null, validHours: 0 });
  });

  it('accepts timestamps with or without a Z suffix and with seconds', () => {
    const t = day().map((x) => `${x}:00Z`);
    expect(windowStats(t, series(Array(12).fill(3)), WINDOW)).toEqual({
      windowMaxM: 3,
      validHours: 12,
    });
  });

  it('returns no valid hours when the series misses the window', () => {
    expect(windowStats(day('2026-02-26'), series(Array(12).fill(3)), WINDOW)).toEqual({
      windowMaxM: null,
      validHours: 0,
    });
  });
});

describe('decideOutcome', () => {
  const obs = (a: number | null, av: number, b: number | null, bv: number) => [
    { id: 'ecmwf_wam', windowMaxM: a, validHours: av },
    { id: 'ncep_gfswave025', windowMaxM: b, validHours: bv },
  ];

  it('is danger only when every model reaches the threshold', () => {
    expect(decideOutcome(RULE, obs(2.86, 12, 2.62, 12))).toBe('danger');
    expect(decideOutcome(RULE, obs(2.5, 12, 2.5, 12))).toBe('danger');
  });

  it('is calme when one model stays below the threshold', () => {
    expect(decideOutcome(RULE, obs(3.4, 12, 2.49, 12))).toBe('calme');
    expect(decideOutcome(RULE, obs(1.2, 12, 1.1, 12))).toBe('calme');
  });

  it('is indisponible when a model has too few valid hours', () => {
    expect(decideOutcome(RULE, obs(3, 9, 3, 12))).toBe('indisponible');
    expect(decideOutcome(RULE, obs(3, 10, 3, 10))).toBe('danger');
  });

  it('is indisponible when a model is missing or has no max', () => {
    expect(decideOutcome(RULE, [{ id: 'ecmwf_wam', windowMaxM: 3, validHours: 12 }])).toBe(
      'indisponible',
    );
    expect(decideOutcome(RULE, obs(null, 12, 3, 12))).toBe('indisponible');
  });

  it('ignores extra models that are not part of the rule', () => {
    const o = [...obs(2.6, 12, 2.7, 12), { id: 'era5_ocean', windowMaxM: 0.1, validHours: 12 }];
    expect(decideOutcome(RULE, o)).toBe('danger');
  });

  it('respects a per-site threshold', () => {
    expect(decideOutcome({ ...RULE, thresholdM: 3 }, obs(2.86, 12, 2.62, 12))).toBe('calme');
  });
});

describe('evaluateTrigger', () => {
  it('computes stats per model and the outcome', () => {
    const res = evaluateTrigger({
      rule: RULE,
      window: WINDOW,
      models: [
        { id: 'ecmwf_wam', time: day(), values: series(Array(12).fill(2.86)) },
        { id: 'ncep_gfswave025', time: day(), values: series(Array(12).fill(2.62)) },
      ],
    });
    expect(res.outcome).toBe('danger');
    expect(res.models).toEqual([
      { id: 'ecmwf_wam', windowMaxM: 2.86, validHours: 12 },
      { id: 'ncep_gfswave025', windowMaxM: 2.62, validHours: 12 },
    ]);
    expect(res.decisiveM).toBe(2.62);
  });

  it('reports a missing model as indisponible', () => {
    const res = evaluateTrigger({
      rule: RULE,
      window: WINDOW,
      models: [{ id: 'ecmwf_wam', time: day(), values: series(Array(12).fill(3)) }],
    });
    expect(res.outcome).toBe('indisponible');
    expect(res.models).toContainEqual({ id: 'ncep_gfswave025', windowMaxM: null, validHours: 0 });
    expect(res.decisiveM).toBeNull();
  });
});
