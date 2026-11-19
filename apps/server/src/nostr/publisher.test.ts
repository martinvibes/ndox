import type { NostrEvent } from '@ndox/oracle';
import { describe, expect, it } from 'vitest';
import { RelayPublisher, type PoolLike } from './publisher.js';

const EVENT = {
  id: 'x',
  pubkey: 'y',
  created_at: 1,
  kind: 88,
  tags: [],
  content: '{}',
  sig: 'z',
} as NostrEvent;
const RELAYS = ['wss://a', 'wss://b', 'wss://c'];

function pool(outcomes: ('ok' | 'fail' | 'hang')[]): PoolLike {
  return {
    publish: (relays) =>
      relays.map((_, i) => {
        const o = outcomes[i];
        if (o === 'ok') return Promise.resolve('');
        if (o === 'fail') return Promise.reject(new Error('blocked: kind not allowed'));
        return new Promise<string>(() => {});
      }),
  };
}

describe('RelayPublisher', () => {
  it('succeeds when at least two relays accept', async () => {
    const p = new RelayPublisher(RELAYS, { pool: pool(['ok', 'fail', 'ok']) });
    const r = await p.publish(EVENT);
    expect(r.ok).toBe(true);
    expect(r.accepted).toEqual(['wss://a', 'wss://c']);
    expect(r.rejected).toEqual([{ relay: 'wss://b', reason: 'blocked: kind not allowed' }]);
  });

  it('fails when fewer than two relays accept, including timeouts', async () => {
    const p = new RelayPublisher(RELAYS, { pool: pool(['ok', 'fail', 'hang']), timeoutMs: 20 });
    const r = await p.publish(EVENT);
    expect(r.ok).toBe(false);
    expect(r.rejected.map((x) => x.reason)).toEqual(['blocked: kind not allowed', 'timeout']);
  });

  it('caps the quorum at the number of relays', async () => {
    const p = new RelayPublisher(['wss://only'], { pool: pool(['ok']) });
    expect((await p.publish(EVENT)).ok).toBe(true);
  });

  it('turns a throwing pool into a failed result', async () => {
    const p = new RelayPublisher(RELAYS, {
      pool: {
        publish: () => {
          throw new Error('boom');
        },
      },
    });
    const r = await p.publish(EVENT);
    expect(r).toMatchObject({ ok: false, accepted: [] });
    expect(r.rejected).toHaveLength(3);
  });
});
