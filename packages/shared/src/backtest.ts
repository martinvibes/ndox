/**
 * Backtest and pricing helpers (docs/BRIEF.md §12). Pure functions over daily window maxima.
 */
import { parseUtc } from './trigger.js';

export interface DailyStat {
  maxM: number | null;
  validHours: number;
}

/** Compact per-day series, as stored in data/seed: index i is `start + i days`. */
export interface DailySeries {
  start: string;
  maxM: (number | null)[];
  valid: number[];
}

/**
 * Per-day max over [startHour, endHour) UTC and the number of valid hours.
 * Days whose valid values are all exactly 0 are land-cell artefacts and get validHours = 0.
 */
export function dailyWindowMaxima(
  time: readonly string[],
  values: readonly (number | null)[],
  startHour = 6,
  endHour = 18,
): DailySeries {
  const byDay = new Map<string, DailyStat>();
  for (let i = 0; i < time.length; i++) {
    const ms = parseUtc(time[i] as string);
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const key = d.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { maxM: null, validHours: 0 });
    const h = d.getUTCHours();
    if (h < startHour || h >= endHour) continue;
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    const s = byDay.get(key) as DailyStat;
    s.validHours++;
    if (s.maxM === null || v > s.maxM) s.maxM = v;
  }
  const keys = [...byDay.keys()].sort();
  if (keys.length === 0) return { start: '', maxM: [], valid: [] };
  const start = keys[0] as string;
  const end = keys[keys.length - 1] as string;
  const out: DailySeries = { start, maxM: [], valid: [] };
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const s = byDay.get(d);
    const landCell = s !== undefined && s.validHours > 0 && s.maxM === 0;
    out.maxM.push(s && !landCell ? s.maxM : null);
    out.valid.push(s && !landCell ? s.validHours : 0);
  }
  return out;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayIndex(series: Pick<DailySeries, 'start'>, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${series.start}T00:00:00Z`)) / 86_400_000);
}

export function dailyAt(series: DailySeries, date: string): DailyStat | undefined {
  const i = dayIndex(series, date);
  if (i < 0 || i >= series.maxM.length) return undefined;
  return { maxM: series.maxM[i] ?? null, validHours: series.valid[i] ?? 0 };
}

const isAllYear = (months: readonly number[]) => months.length === 12;
const wraps = (months: readonly number[]) => !isAllYear(months) && months.includes(12) && months.includes(1);

/**
 * Season label for a date: "2025" for all-year sites, "2024-25" for a Dec–Jun season
 * (December belongs to the season that ends the following June). null if out of season.
 */
export function seasonOf(date: string, seasonMonths: readonly number[]): string | null {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (!seasonMonths.includes(m)) return null;
  if (!wraps(seasonMonths)) return String(y);
  const first = Math.min(...seasonMonths.filter((x) => x >= 7));
  const startYear = m >= first ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** First and last calendar day of a season label. */
export function seasonBounds(season: string, seasonMonths: readonly number[]): [string, string] {
  const y = Number(season.slice(0, 4));
  if (!wraps(seasonMonths)) {
    const first = Math.min(...seasonMonths);
    const last = Math.max(...seasonMonths);
    return [`${y}-${pad(first)}-01`, lastDayOfMonth(y, last)];
  }
  const startMonth = Math.min(...seasonMonths.filter((x) => x >= 7));
  const endMonth = Math.max(...seasonMonths.filter((x) => x < 7));
  return [`${y}-${pad(startMonth)}-01`, lastDayOfMonth(y + 1, endMonth)];
}

const pad = (n: number) => String(n).padStart(2, '0');

function lastDayOfMonth(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** Average number of days in a season (February counts 28.25). */
export function seasonDays(seasonMonths: readonly number[]): number {
  const len = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return seasonMonths.reduce((acc, m) => acc + (len[m - 1] as number), 0);
}

export interface SeasonCount {
  season: string;
  dangerDays: number;
  days: number;
  missingDays: number;
}

/** Danger days per complete season (seasons not fully covered by the series are dropped). */
export function dangerDaysBySeason(
  series: DailySeries,
  opts: { thresholdM: number; minValidHours: number; seasonMonths: readonly number[] },
): SeasonCount[] {
  const map = new Map<string, SeasonCount>();
  const end = addDays(series.start, series.maxM.length - 1);
  for (let i = 0; i < series.maxM.length; i++) {
    const date = addDays(series.start, i);
    const season = seasonOf(date, opts.seasonMonths);
    if (season === null) continue;
    const c = map.get(season) ?? { season, dangerDays: 0, days: 0, missingDays: 0 };
    c.days++;
    const max = series.maxM[i];
    const valid = series.valid[i] ?? 0;
    if (max === null || max === undefined || valid < opts.minValidHours) c.missingDays++;
    else if (max >= opts.thresholdM) c.dangerDays++;
    map.set(season, c);
  }
  return [...map.values()]
    .filter((c) => {
      const [first, last] = seasonBounds(c.season, opts.seasonMonths);
      return first >= series.start && last <= end;
    })
    .sort((a, b) => a.season.localeCompare(b.season));
}

export interface Summary {
  n: number;
  mean: number;
  p90: number;
  worst: number;
  best: number;
}

/** mean, nearest-rank p90, max and min of a list of counts. */
export function summarize(counts: readonly number[]): Summary {
  if (counts.length === 0) return { n: 0, mean: 0, p90: 0, worst: 0, best: 0 };
  const sorted = [...counts].sort((a, b) => a - b);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1] as number;
  return {
    n: counts.length,
    mean: Math.round(mean * 100) / 100,
    p90,
    worst: sorted[sorted.length - 1] as number,
    best: sorted[0] as number,
  };
}

/**
 * Weekly premium per crew (FCFA, rounded up to a whole franc):
 *   (mean danger days per season × payout) ÷ weeks in season × (1 + loading)
 */
export function weeklyPremiumFcfa(p: {
  meanDangerDays: number;
  payoutFcfa: number;
  seasonDays: number;
  loading: number;
}): number {
  if (!Number.isInteger(p.payoutFcfa) || p.payoutFcfa < 0) throw new Error('payoutFcfa must be an integer');
  const weeks = p.seasonDays / 7;
  const raw = ((p.meanDangerDays * p.payoutFcfa) / weeks) * (1 + p.loading);
  return Math.ceil(Math.round(raw * 1000) / 1000);
}
