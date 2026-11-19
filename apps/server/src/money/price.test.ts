import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryDb, settableClock } from '../test/helpers.js';
import { PRICE_URL, PriceService, PriceUnavailableError } from './price.js';

function fakeFetch(responses: (object | Error | number)[]) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const r = responses.shift() ?? new Error('no more responses');
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('nope', { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const mempool = (eur: number, time = 1_795_095_305) => ({ time, USD: 63_633, EUR: eur });

describe('PriceService', () => {
  it('fetches BTC/EUR from mempool.space, converts at the peg and caches for 10 minutes', async () => {
    const db = memoryDb();
    const t = settableClock('2026-11-19T12:00:00Z');
    const f = fakeFetch([mempool(57_941), mempool(60_000)]);
    const s = new PriceService({ db, clock: t.clock, fetchImpl: f.impl });

    const p = await s.get();
    expect(p).toMatchObject({
      eurPerBtc: 57_941,
      xofPerBtc: 38_006_805,
      source: 'mempool.space',
      stale: false,
      fetchedAt: '2026-11-19T12:00:00Z',
      asOf: '2026-11-19T13:35:05Z',
    });
    expect(f.calls).toEqual([PRICE_URL]);

    t.set('2026-11-19T12:09:59Z');
    expect((await s.get()).eurPerBtc).toBe(57_941);
    expect(f.calls).toHaveLength(1);

    t.set('2026-11-19T12:10:00Z');
    expect((await s.get()).eurPerBtc).toBe(60_000);
    expect(f.calls).toHaveLength(2);
  });

  it('returns the last known price flagged stale when mempool.space fails, retrying at most once a minute', async () => {
    const db = memoryDb();
    const t = settableClock('2026-11-19T12:00:00Z');
    const f = fakeFetch([mempool(57_941), new Error('ECONNRESET'), 503, mempool(58_000)]);
    const s = new PriceService({ db, clock: t.clock, fetchImpl: f.impl });
    await s.get();

    t.set('2026-11-19T12:11:00Z');
    const stale = await s.get();
    expect(stale).toMatchObject({ eurPerBtc: 57_941, stale: true });
    t.set('2026-11-19T12:11:30Z');
    await s.get();
    expect(f.calls).toHaveLength(2); // no retry within a minute

    t.set('2026-11-19T12:12:00Z');
    expect(await s.get()).toMatchObject({ eurPerBtc: 57_941, stale: true }); // HTTP 503
    t.set('2026-11-19T12:13:00Z');
    expect(await s.get()).toMatchObject({ eurPerBtc: 58_000, stale: false });
  });

  it('keeps the last price across restarts (stored in settings)', async () => {
    const db = memoryDb();
    const t = settableClock('2026-11-19T12:00:00Z');
    await new PriceService({
      db,
      clock: t.clock,
      fetchImpl: fakeFetch([mempool(57_941)]).impl,
    }).get();

    t.set('2026-11-19T15:00:00Z');
    const restarted = new PriceService({
      db,
      clock: t.clock,
      fetchImpl: fakeFetch([new Error('offline')]).impl,
    });
    expect(restarted.peek()).toMatchObject({ eurPerBtc: 57_941, stale: true });
    expect(await restarted.get()).toMatchObject({
      eurPerBtc: 57_941,
      stale: true,
      fetchedAt: '2026-11-19T12:00:00Z',
    });
  });

  it('falls back to the committed seed price (stale) when nothing is known, else throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndox-price-'));
    const seedFile = join(dir, 'price.json');
    writeFileSync(
      seedFile,
      JSON.stringify({ source: PRICE_URL, fetchedAt: '2026-11-19T13:55:05Z', ...mempool(57_941) }),
    );
    const t = settableClock('2026-11-20T00:00:00Z');
    const offline = () => fakeFetch([new Error('offline'), new Error('offline')]).impl;

    const s = new PriceService({ db: memoryDb(), clock: t.clock, fetchImpl: offline(), seedFile });
    expect(await s.get()).toMatchObject({ eurPerBtc: 57_941, source: 'seed', stale: true });

    const none = new PriceService({
      db: memoryDb(),
      clock: t.clock,
      fetchImpl: offline(),
      seedFile: join(dir, 'missing.json'),
    });
    await expect(none.get()).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it('treats malformed responses as failures', async () => {
    const t = settableClock('2026-11-19T12:00:00Z');
    for (const bad of [{ time: 1, USD: 1 }, mempool(-5), mempool(0), { EUR: 'x', time: 1 }]) {
      const s = new PriceService({
        db: memoryDb(),
        clock: t.clock,
        fetchImpl: fakeFetch([bad]).impl,
      });
      await expect(s.get()).rejects.toBeInstanceOf(PriceUnavailableError);
    }
  });

  it('shares one request between concurrent callers', async () => {
    const t = settableClock('2026-11-19T12:00:00Z');
    const f = fakeFetch([mempool(57_941)]);
    const s = new PriceService({ db: memoryDb(), clock: t.clock, fetchImpl: f.impl });
    const [a, b] = await Promise.all([s.get(), s.get()]);
    expect(a.eurPerBtc).toBe(b.eurPerBtc);
    expect(f.calls).toHaveLength(1);
  });
});
