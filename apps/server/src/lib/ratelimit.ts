/**
 * Fixed-window, in-memory rate limiter (one process; enough for a single-node deployment).
 * Nothing is persisted or logged.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit. Returns 0 if allowed, else the seconds until the window resets. */
  take(key: string): number {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t >= h.reset) {
      if (this.hits.size >= 10_000) this.prune(t);
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
    }
    if (h.n >= this.limit) return Math.max(1, Math.ceil((h.reset - t) / 1000));
    h.n++;
    return 0;
  }

  /** Forgets a key (e.g. after a successful login). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (t >= v.reset) this.hits.delete(k);
  }
}
