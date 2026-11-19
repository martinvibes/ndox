import { describe, expect, it } from 'vitest';
import {
  addDays,
  dailyAt,
  dailyWindowMaxima,
  dangerDaysBySeason,
  seasonBounds,
  seasonDays,
  seasonOf,
  summarize,
  weeklyPremiumFcfa,
} from './backtest.js';
import { marineUrl, parseMarineResponse, seriesFromResponse } from './openmeteo.js';

const KAYAR = [12, 1, 2, 3, 4, 5, 6];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function hourly(days: string[], f: (day: number, hour: number) => number | null) {
  const time: string[] = [];
  const values: (number | null)[] = [];
  days.forEach((d, di) => {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      values.push(f(di, h));
    }
  });
  return { time, values };
}

describe('dailyWindowMaxima', () => {
  it('computes the 06–18 max and valid hours per day', () => {
    const { time, values } = hourly(['2026-02-26', '2026-02-27'], (d, h) => (h === 3 ? 9 : d + h / 10));
    const s = dailyWindowMaxima(time, values);
    expect(s.start).toBe('2026-02-26');
    expect(s.maxM).toEqual([1.7, 2.7]);
    expect(s.valid).toEqual([12, 12]);
    expect(dailyAt(s, '2026-02-27')).toEqual({ maxM: 2.7, validHours: 12 });
    expect(dailyAt(s, '2026-03-01')).toBeUndefined();
  });

  it('marks all-zero days as invalid (land cell) and fills gaps', () => {
    const { time, values } = hourly(['2026-01-01', '2026-01-03'], (d) => (d === 0 ? 0 : 1));
    const s = dailyWindowMaxima(time, values);
    expect(s.maxM).toEqual([null, null, 1]);
    expect(s.valid).toEqual([0, 0, 12]);
  });
});

describe('seasons', () => {
  it('labels Dec–Jun seasons across the year boundary', () => {
    expect(seasonOf('2025-12-14', KAYAR)).toBe('2025-26');
    expect(seasonOf('2026-02-27', KAYAR)).toBe('2025-26');
    expect(seasonOf('2026-06-30', KAYAR)).toBe('2025-26');
    expect(seasonOf('2026-07-01', KAYAR)).toBeNull();
    expect(seasonOf('1999-12-31', KAYAR)).toBe('1999-00');
    expect(seasonOf('2026-07-01', ALL)).toBe('2026');
  });

  it('gives season bounds', () => {
    expect(seasonBounds('2025-26', KAYAR)).toEqual(['2025-12-01', '2026-06-30']);
    expect(seasonBounds('2024', ALL)).toEqual(['2024-01-01', '2024-12-31']);
  });

  it('measures season length', () => {
    expect(seasonDays(KAYAR)).toBe(212.25);
    expect(seasonDays(ALL)).toBe(365.25);
  });
});

describe('dangerDaysBySeason', () => {
  it('counts danger days only in complete seasons, honouring minValidHours', () => {
    const start = '2024-01-01';
    const n = 731; // 2024-01-01 .. 2025-12-31
    const maxM = Array.from({ length: n }, (_, i) => (addDays(start, i).endsWith('-01') ? 3 : 1));
    const valid = Array(n).fill(12);
    valid[0] = 5; // 2024-01-01 is not valid
    const counts = dangerDaysBySeason(
      { start, maxM, valid },
      { thresholdM: 2.5, minValidHours: 10, seasonMonths: ALL },
    );
    expect(counts).toEqual([
      { season: '2024', dangerDays: 11, days: 366, missingDays: 1 },
      { season: '2025', dangerDays: 12, days: 365, missingDays: 0 },
    ]);
    // Kayar: only 2024-25 is complete (Dec 2024 – Jun 2025)
    const k = dangerDaysBySeason({ start, maxM, valid }, { thresholdM: 2.5, minValidHours: 10, seasonMonths: KAYAR });
    expect(k.map((c) => c.season)).toEqual(['2024-25']);
    expect(k[0]?.dangerDays).toBe(7);
  });
});

describe('summarize and premium', () => {
  it('computes mean, nearest-rank p90, worst', () => {
    expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, mean: 5.5, p90: 9, worst: 10, best: 1 });
    expect(summarize([])).toEqual({ n: 0, mean: 0, p90: 0, worst: 0, best: 0 });
  });

  it('prices the weekly premium from the mean and rounds up', () => {
    // 10 danger days × 2000 / (212.25/7) × 1.25 = 824.5…
    expect(weeklyPremiumFcfa({ meanDangerDays: 10, payoutFcfa: 2000, seasonDays: 212.25, loading: 0.25 })).toBe(825);
    expect(weeklyPremiumFcfa({ meanDangerDays: 0, payoutFcfa: 2000, seasonDays: 365.25, loading: 0.25 })).toBe(0);
    expect(() => weeklyPremiumFcfa({ meanDangerDays: 1, payoutFcfa: 2.5, seasonDays: 7, loading: 0 })).toThrow();
  });
});

describe('openmeteo helpers', () => {
  it('builds stable URLs', () => {
    expect(
      marineUrl({ lat: 14.95, lon: -17.2, model: 'ecmwf_wam', startDate: '2026-02-27', endDate: '2026-02-27' }),
    ).toBe(
      'https://marine-api.open-meteo.com/v1/marine?latitude=14.95&longitude=-17.20&hourly=wave_height,swell_wave_height&models=ecmwf_wam&timezone=GMT&start_date=2026-02-27&end_date=2026-02-27',
    );
  });

  it('parses responses and maps unsupported variables to nulls', () => {
    const body = JSON.stringify({
      latitude: 14.94,
      longitude: -17.21,
      hourly_units: { swell_wave_height: 'undefined' },
      hourly: { time: ['2026-02-27T06:00', '2026-02-27T07:00'], wave_height: [2.8, 2.86], swell_wave_height: [null, null] },
    });
    const r = parseMarineResponse(body);
    expect(seriesFromResponse(r, 'wave_height').values).toEqual([2.8, 2.86]);
    expect(seriesFromResponse(r, 'swell_wave_height').values).toEqual([null, null]);
    expect(seriesFromResponse(r, 'nope').values).toEqual([null, null]);
  });

  it('throws on API errors', () => {
    expect(() => parseMarineResponse('{"error":true,"reason":"bad model"}')).toThrow(/bad model/);
    expect(() => parseMarineResponse('<html>')).toThrow();
  });
});
