import { openDb, type Db } from '../db/index.js';
import { deriveKey } from '../lib/box.js';
import { silentLog } from '../lib/log.js';
import type { OracleCtx } from '../oracle/jobs.js';
import { DEFAULT_PATHS } from '../paths.js';
import {
  sha256Hex,
  urlFor,
  type Envelope,
  type ForecastSource,
  type RangeQuery,
} from '../wave/source.js';

export const TEST_ORACLE_SECRET = '1f'.repeat(32);
export const TEST_DEMO_SECRET = '2e'.repeat(32);

export function memoryDb(defaultThresholdM = 2.5): Db {
  return openDb(':memory:', { migrationsDir: DEFAULT_PATHS.migrationsDir, defaultThresholdM });
}

export function settableClock(iso: string): { clock: () => Date; set: (iso: string) => void } {
  let now = new Date(iso);
  return { clock: () => now, set: (v: string) => (now = new Date(v)) };
}

export function makeCtx(db: Db, overrides: Partial<OracleCtx> = {}): OracleCtx {
  const secret = overrides.secret ?? TEST_ORACLE_SECRET;
  return {
    db,
    secret,
    nonceKey: deriveKey(secret, 'nonce'),
    source: overrides.source ?? new StubSource(() => new Error('no source')),
    publisher: null,
    relays: ['wss://relay.example'],
    clock: () => new Date(),
    log: silentLog,
    ...overrides,
  };
}

/** A marine API body with 24 hourly values for each day in [startDate, endDate]. */
export function marineBody(
  q: RangeQuery,
  value: (date: string, hour: number) => number | null,
): string {
  const time: string[] = [];
  const wave: (number | null)[] = [];
  for (
    let d = new Date(`${q.startDate}T00:00:00Z`);
    d <= new Date(`${q.endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const date = d.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      wave.push(value(date, h));
    }
  }
  return JSON.stringify({
    latitude: q.site.lat,
    longitude: q.site.lon,
    hourly_units: { time: 'iso8601', wave_height: 'm' },
    hourly: { time, wave_height: wave, swell_wave_height: wave.map(() => null) },
  });
}

export function envelope(
  q: RangeQuery,
  body: string,
  fetchedAt = '2026-02-27T05:00:07Z',
): Envelope {
  return { url: urlFor(q), fetchedAt, sha256: sha256Hex(body), body };
}

/** Per-model constant wave height (null value = model fails). */
export class StubSource implements ForecastSource {
  readonly name = 'stub';
  calls: RangeQuery[] = [];
  constructor(private readonly f: (q: RangeQuery) => Envelope | Error) {}
  get(q: RangeQuery): Promise<Envelope> {
    this.calls.push(q);
    const r = this.f(q);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
  static constant(byModel: Record<string, number | Error>): StubSource {
    return new StubSource((q) => {
      const v = byModel[q.model];
      if (v === undefined) return new Error(`no data for ${q.model}`);
      if (v instanceof Error) return v;
      return envelope(
        q,
        marineBody(q, (_d, h) => (h === 12 ? v : Math.max(0.1, v - 0.5))),
      );
    });
  }
}
