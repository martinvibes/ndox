/**
 * Display formatting (docs/BRIEF.md §10.2). Amounts are integers end to end; times are shown in
 * GMT, which is Dakar's local time all year.
 */
import { fcfaToEurCents } from '@ndox/shared';

export type Lang = 'fr' | 'en';

const NBSP = ' ';
const locale = (lang: Lang) => (lang === 'fr' ? 'fr-SN' : 'en-GB');

const cache = new Map<string, Intl.NumberFormat>();
function nf(lang: Lang, opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${lang}:${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(lang), opts);
    cache.set(key, f);
  }
  return f;
}

export const fmtInt = (n: number, lang: Lang) => nf(lang, { maximumFractionDigits: 0 }).format(n);
export const fmtFcfa = (n: number, lang: Lang) => `${fmtInt(n, lang)}${NBSP}FCFA`;
export const fmtSat = (n: number, lang: Lang) => `${fmtInt(n, lang)}${NBSP}sats`;

export function fmtEurFromFcfa(fcfa: number, lang: Lang): string {
  return nf(lang, { style: 'currency', currency: 'EUR' }).format(fcfaToEurCents(fcfa) / 100);
}

/** Metres with two decimals ("2,81 m"). */
export function fmtM(m: number | null | undefined, lang: Lang): string {
  if (m === null || m === undefined) return '—';
  return `${nf(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m)}${NBSP}m`;
}

export function fmtPct(ratio: number, lang: Lang): string {
  return nf(lang, { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/** "05:15 GMT" */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}${NBSP}GMT`;
}

function toDate(dateOrIso: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? `${dateOrIso}T12:00:00Z` : dateOrIso);
}

const DATE_STYLES: Record<'long' | 'short' | 'day', Intl.DateTimeFormatOptions> = {
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
  short: { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  day: { weekday: 'short', day: 'numeric', timeZone: 'UTC' },
};

/** "jeudi 19 novembre 2026" (long), "19 nov. 2026" (short) or "jeu. 19" (day), in GMT. */
export function fmtDate(
  dateOrIso: string,
  lang: Lang,
  style: 'long' | 'short' | 'day' = 'short',
): string {
  return new Intl.DateTimeFormat(locale(lang), DATE_STYLES[style]).format(toDate(dateOrIso));
}

/** "19 nov. 2026, 05:15 GMT" */
export function fmtDateTime(iso: string, lang: Lang): string {
  return `${fmtDate(iso, lang)}, ${fmtTime(iso)}`;
}

/** Hex shortened for display: "3f9a1c2b…e4d0". */
export function shortHex(hex: string, head = 8, tail = 4): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** sats → FCFA (floor, for display only; amounts on the books are stored separately). */
export function satToFcfaDisplay(sat: number, xofPerBtc: number): number {
  return Math.floor((sat * xofPerBtc) / 100_000_000);
}

/** Hours (rounded up) until `iso`, never negative. */
export function hoursUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 3_600_000));
}
