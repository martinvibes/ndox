/**
 * Where forecasts come from. Every response is kept byte-for-byte with its URL, fetch time
 * and SHA-256 (the hash is published in the attestation).
 *   OpenMeteoSource — live HTTP (Open-Meteo Marine API)
 *   SeedSource      — data/seed/forecasts/<date>/<site>/<model>.json (offline replays)
 */
import { marineUrl, parseMarineResponse, type SiteConfig } from '@ndox/shared';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isoSeconds } from '../lib/time.js';

export interface Envelope {
  url: string;
  fetchedAt: string;
  sha256: string;
  body: string;
}

export interface RangeQuery {
  site: SiteConfig;
  model: string;
  startDate: string;
  endDate: string;
}

export interface ForecastSource {
  readonly name: string;
  get(q: RangeQuery): Promise<Envelope>;
}

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export function urlFor(q: RangeQuery): string {
  return marineUrl({
    lat: q.site.lat,
    lon: q.site.lon,
    model: q.model,
    startDate: q.startDate,
    endDate: q.endDate,
  });
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class OpenMeteoSource implements ForecastSource {
  readonly name = 'open-meteo';
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly opts: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
  ) {}

  async get(q: RangeQuery): Promise<Envelope> {
    const url = urlFor(q);
    const attempts = this.opts.attempts ?? 3;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'user-agent': 'ndox-oracle/0.1' },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        parseMarineResponse(body); // throws on API errors / unexpected shapes
        return { url, fetchedAt: isoSeconds(new Date()), sha256: sha256Hex(body), body };
      } catch (err) {
        lastErr = err;
        if (i < attempts)
          await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 1000) * i * i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

export class SeedSource implements ForecastSource {
  readonly name = 'seed';
  constructor(private readonly seedDir: string) {}

  async get(q: RangeQuery): Promise<Envelope> {
    if (q.startDate !== q.endDate) throw new Error('seed forecasts are stored per day');
    const path = join(this.seedDir, 'forecasts', q.startDate, q.site.id, `${q.model}.json`);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new Error(`no seed forecast for ${q.site.id} ${q.startDate} ${q.model}`);
    }
    const env = JSON.parse(raw) as Partial<Envelope>;
    if (
      typeof env.body !== 'string' ||
      typeof env.url !== 'string' ||
      typeof env.fetchedAt !== 'string'
    ) {
      throw new Error(`malformed seed forecast ${path}`);
    }
    if (env.url !== urlFor(q)) throw new Error(`seed forecast URL mismatch for ${path}`);
    if (sha256Hex(env.body) !== env.sha256)
      throw new Error(`seed forecast hash mismatch for ${path}`);
    parseMarineResponse(env.body);
    return { url: env.url, fetchedAt: env.fetchedAt, sha256: env.sha256, body: env.body };
  }
}

/** Tries each source in order. */
export class ChainSource implements ForecastSource {
  readonly name: string;
  constructor(private readonly sources: ForecastSource[]) {
    this.name = sources.map((s) => s.name).join('+');
  }
  async get(q: RangeQuery): Promise<Envelope> {
    const errors: string[] = [];
    for (const s of this.sources) {
      try {
        return await s.get(q);
      } catch (err) {
        errors.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(errors.join('; '));
  }
}
