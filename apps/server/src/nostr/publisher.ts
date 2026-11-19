/**
 * Publishes signed events to Nostr relays. Success = at least `minAccepted` relays (default 2,
 * capped at the number of relays) acknowledged the event with OK true.
 */
import type { NostrEvent } from '@ndox/oracle';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';
import { errorMessage } from '../lib/log.js';

useWebSocketImplementation(WebSocket);

export interface PublishResult {
  ok: boolean;
  accepted: string[];
  rejected: { relay: string; reason: string }[];
  at: string;
}

/** Failed publishes are retried after this delay. */
export const PUBLISH_RETRY_MS = 5 * 60_000;

/** True if a stored publish result is missing or old enough to try again. */
export function dueForRetry(result: unknown, now: Date, afterMs = PUBLISH_RETRY_MS): boolean {
  const at = (result as Partial<PublishResult> | null)?.at;
  return !at || now.getTime() - Date.parse(at) >= afterMs;
}

export interface Publisher {
  publish(event: NostrEvent): Promise<PublishResult>;
  close?(): void;
}

export interface PoolLike {
  publish(relays: string[], event: NostrEvent, params?: { maxWait?: number }): Promise<string>[];
  close?(relays: string[]): void;
}

export interface RelayPublisherOptions {
  minAccepted?: number;
  timeoutMs?: number;
  pool?: PoolLike;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class RelayPublisher implements Publisher {
  private readonly pool: PoolLike;
  private readonly minAccepted: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly relays: string[],
    opts: RelayPublisherOptions = {},
  ) {
    if (relays.length === 0) throw new Error('no relays configured');
    this.pool = opts.pool ?? new SimplePool();
    this.minAccepted = Math.min(opts.minAccepted ?? 2, relays.length);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async publish(event: NostrEvent): Promise<PublishResult> {
    let promises: Promise<string>[];
    try {
      promises = this.pool.publish(this.relays, event, { maxWait: this.timeoutMs });
    } catch (err) {
      promises = this.relays.map(() => Promise.reject(new Error(errorMessage(err))));
    }
    const settled = await Promise.allSettled(
      promises.map((p) => withTimeout(p, this.timeoutMs + 1000)),
    );
    const accepted: string[] = [];
    const rejected: { relay: string; reason: string }[] = [];
    settled.forEach((r, i) => {
      const relay = this.relays[i] as string;
      if (r.status === 'fulfilled') accepted.push(relay);
      else rejected.push({ relay, reason: errorMessage(r.reason).slice(0, 200) });
    });
    return {
      ok: accepted.length >= this.minAccepted,
      accepted,
      rejected,
      at: new Date().toISOString(),
    };
  }

  close(): void {
    this.pool.close?.(this.relays);
  }
}

/** Test/replay helper: accepts every event and keeps it in memory. */
export class MemoryPublisher implements Publisher {
  readonly events: NostrEvent[] = [];
  constructor(private readonly accept = true) {}
  publish(event: NostrEvent): Promise<PublishResult> {
    if (this.accept) this.events.push(event);
    return Promise.resolve({
      ok: this.accept,
      accepted: this.accept ? ['memory://'] : [],
      rejected: this.accept ? [] : [{ relay: 'memory://', reason: 'rejected' }],
      at: new Date().toISOString(),
    });
  }
}
