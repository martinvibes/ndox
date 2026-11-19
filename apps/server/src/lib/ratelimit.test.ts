import { describe, expect, it } from 'vitest';
import { RateLimiter } from './ratelimit.js';

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then reports the wait, per key', () => {
    let t = 0;
    const rl = new RateLimiter(2, 10_000, () => t);
    expect(rl.take('a')).toBe(0);
    expect(rl.take('a')).toBe(0);
    expect(rl.take('a')).toBe(10);
    expect(rl.take('b')).toBe(0);
    t = 9_001;
    expect(rl.take('a')).toBe(1);
    t = 10_000;
    expect(rl.take('a')).toBe(0);
  });

  it('reset forgets a key', () => {
    const rl = new RateLimiter(1, 60_000, () => 0);
    expect(rl.take('k')).toBe(0);
    expect(rl.take('k')).toBe(60);
    rl.reset('k');
    expect(rl.take('k')).toBe(0);
  });
});
