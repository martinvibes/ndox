/**
 * BTC price for FCFA ↔ sats (docs/BRIEF.md §5.4): BTC/EUR from mempool.space, XOF via the fixed
 * 655.957 peg. Cached 10 minutes. When mempool.space is unreachable the last known price is
 * returned with `stale: true` (shown in the UI), surviving restarts via the settings table, and
 * finally the committed seed snapshot (also stale) so an offline Docker demo still works.
 */
import { xofPerBtcFromEur } from '@ndox/shared';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { isoSeconds, type Clock } from '../lib/time.js';

export const PRICE_URL = 'https://mempool.space/api/v1/prices';
const SETTINGS_KEY = 'price.last';

export interface Price {
  eurPerBtc: number;
  xofPerBtc: number;
  /** When mempool.space computed the price. */
  asOf: string;
  /** When we fetched it. */
  fetchedAt: string;
  source: 'mempool.space' | 'seed';
  /** True when the price is older than the cache TTL (refresh failed). */
  stale: boolean;
}

export class PriceUnavailableError extends Error {
  constructor(message = 'no BTC price available') {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

const MempoolPrices = z.object({
  time: z.number().int().positive(),
  EUR: z.number().positive(),
});

const Stored = z.object({
  eurPerBtc: z.number().int().positive(),
  asOf: z.string(),
  fetchedAt: z.string(),
  source: z.enum(['mempool.space', 'seed']),
});
type Stored = z.infer<typeof Stored>;

export interface PriceServiceOptions {
  db: Db;
  clock: Clock;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /** Minimum delay between two refresh attempts after a failure. */
  retryMs?: number;
  timeoutMs?: number;
  /** data/seed/price.json: { time, EUR, fetchedAt } snapshot. */
  seedFile?: string;
}

export class PriceService {
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private last: Stored | null;
  private nextTryAt = 0;
  private inflight: Promise<Price> | null = null;

  constructor(private readonly o: PriceServiceOptions) {
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.retryMs = o.retryMs ?? 60_000;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.last = this.loadStored() ?? this.loadSeed();
  }

  /** The last known price without any network call (null if none at all). */
  peek(): Price | null {
    return this.last ? this.view(this.last) : null;
  }

  get(): Promise<Price> {
    const now = this.o.clock().getTime();
    if (
      this.last &&
      this.last.source !== 'seed' &&
      now - Date.parse(this.last.fetchedAt) < this.ttlMs
    )
      return Promise.resolve(this.view(this.last));
    if (now < this.nextTryAt) return this.fallback();
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh(): Promise<Price> {
    try {
      const res = await this.fetchImpl(PRICE_URL, {
        headers: { accept: 'application/json', 'user-agent': 'ndox-oracle/0.1' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = MempoolPrices.parse(await res.json());
      const stored: Stored = {
        eurPerBtc: Math.round(body.EUR),
        asOf: isoSeconds(new Date(body.time * 1000)),
        fetchedAt: isoSeconds(this.o.clock()),
        source: 'mempool.space',
      };
      this.last = stored;
      this.nextTryAt = 0;
      this.o.db
        .insert(settings)
        .values({ key: SETTINGS_KEY, value: stored })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: stored, updatedAt: stored.fetchedAt },
        })
        .run();
      return this.view(stored);
    } catch {
      this.nextTryAt = this.o.clock().getTime() + this.retryMs;
      return this.fallback();
    }
  }

  private fallback(): Promise<Price> {
    return this.last
      ? Promise.resolve(this.view(this.last))
      : Promise.reject(new PriceUnavailableError());
  }

  private view(s: Stored): Price {
    const age = this.o.clock().getTime() - Date.parse(s.fetchedAt);
    return {
      eurPerBtc: s.eurPerBtc,
      xofPerBtc: xofPerBtcFromEur(s.eurPerBtc),
      asOf: s.asOf,
      fetchedAt: s.fetchedAt,
      source: s.source,
      stale: s.source === 'seed' || age >= this.ttlMs,
    };
  }

  private loadStored(): Stored | null {
    const row = this.o.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
    const parsed = Stored.safeParse(row?.value);
    return parsed.success ? parsed.data : null;
  }

  private loadSeed(): Stored | null {
    const file = this.o.seedFile;
    if (!file || !existsSync(file)) return null;
    const seed = MempoolPrices.extend({ fetchedAt: z.string() }).safeParse(
      JSON.parse(readFileSync(file, 'utf8')),
    );
    if (!seed.success) return null;
    return {
      eurPerBtc: Math.round(seed.data.EUR),
      asOf: isoSeconds(new Date(seed.data.time * 1000)),
      fetchedAt: seed.data.fetchedAt,
      source: 'seed',
    };
  }
}
