/** UTC helpers. Senegal is UTC+0 all year (no DST), so every schedule is in UTC. */

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** "2026-02-27T05:15:00Z" (second precision, as used in event content). */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Date at `HH:MM` UTC on `date` (YYYY-MM-DD). */
export function atUtc(date: string, hhmm: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hhmm))
    throw new Error('invalid date/time');
  return new Date(`${date}T${hhmm}:00Z`);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDate(d) === date;
}
