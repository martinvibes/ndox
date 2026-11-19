/**
 * The Ndox trigger rule (docs/BRIEF.md §5.3), as pure functions.
 *
 *   for each model m: max_m = max(hourly value in [window.start, window.end))
 *   if any model missing or has < minValidHours valid hours → "indisponible"
 *   else if min(max_m) >= threshold → "danger"
 *   else → "calme"
 *
 * The same functions run in the oracle job, the backtest, and the in-browser verifier.
 */

export type Outcome = 'calme' | 'danger' | 'indisponible';

export interface WindowStats {
  windowMaxM: number | null;
  validHours: number;
}

export interface ModelStats extends WindowStats {
  id: string;
}

export interface TriggerRule {
  thresholdM: number;
  minValidHours: number;
  /** Every listed model must be present and valid. */
  models: readonly string[];
}

export interface TimeWindow {
  start: string;
  end: string;
}

/** Parses Open-Meteo hourly timestamps ("2026-02-27T06:00", GMT) and full ISO strings. */
export function parseUtc(t: string): number {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) return Date.parse(`${t}:00Z`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) return Date.parse(`${t}Z`);
  return Date.parse(t);
}

function isValidValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Window max and number of valid hours. A window whose valid values are all exactly 0 is
 * treated as having no valid hours: Open-Meteo returns 0.00 (not null) for land cells.
 */
export function windowStats(
  time: readonly string[],
  values: readonly (number | null)[],
  window: TimeWindow,
): WindowStats {
  const start = parseUtc(window.start);
  const end = parseUtc(window.end);
  let max: number | null = null;
  let valid = 0;
  for (let i = 0; i < time.length; i++) {
    const t = parseUtc(time[i] as string);
    if (!(t >= start && t < end)) continue;
    const v = values[i];
    if (!isValidValue(v)) continue;
    valid++;
    if (max === null || v > max) max = v;
  }
  if (valid > 0 && max === 0) return { windowMaxM: null, validHours: 0 };
  return { windowMaxM: max, validHours: valid };
}

/** Applies the rule to per-model window statistics (e.g. the data published in an attestation). */
export function decideOutcome(rule: TriggerRule, observations: readonly ModelStats[]): Outcome {
  const maxima: number[] = [];
  for (const id of rule.models) {
    const o = observations.find((x) => x.id === id);
    if (!o || o.windowMaxM === null || o.validHours < rule.minValidHours) return 'indisponible';
    maxima.push(o.windowMaxM);
  }
  if (maxima.length === 0) return 'indisponible';
  return Math.min(...maxima) >= rule.thresholdM ? 'danger' : 'calme';
}

export interface ModelSeries {
  id: string;
  time: readonly string[];
  values: readonly (number | null)[];
}

export interface TriggerResult {
  outcome: Outcome;
  models: ModelStats[];
  /** min over models of the window max — the value compared to the threshold. */
  decisiveM: number | null;
}

export function evaluateTrigger(input: {
  rule: TriggerRule;
  window: TimeWindow;
  models: readonly ModelSeries[];
}): TriggerResult {
  const stats: ModelStats[] = input.rule.models.map((id) => {
    const s = input.models.find((m) => m.id === id);
    if (!s) return { id, windowMaxM: null, validHours: 0 };
    return { id, ...windowStats(s.time, s.values, input.window) };
  });
  const outcome = decideOutcome(input.rule, stats);
  const maxima = stats.map((s) => s.windowMaxM);
  const decisiveM = maxima.every((m): m is number => m !== null) ? Math.min(...maxima) : null;
  return { outcome, models: stats, decisiveM };
}
