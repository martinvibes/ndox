import { finalizeEvent, getPublicKey, type NostrEvent } from '@ndox/oracle';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { deposits } from '../db/schema.js';
import { silentLog } from '../lib/log.js';
import { unixSeconds } from '../lib/time.js';
import type { Publisher, PublishResult } from '../nostr/publisher.js';
import { DEFAULT_PATHS } from '../paths.js';
import { runPayoutJobs } from '../payouts/engine.js';
import { createServices } from '../services.js';
import { memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { encodeBolt11 } from '../wallet/bolt11.js';
import type { InvoiceLookup, Wallet } from '../wallet/types.js';
import {
  checkZapReceipt,
  fetchZapperPubkey,
  publishPoolProfile,
  ZapWatcher,
  type ZapSource,
} from './zaps.js';

const POOL_SECRET = '33'.repeat(32);
const POOL = getPublicKey(POOL_SECRET);
const ZAPPER_SECRET = '77'.repeat(32);
const ZAPPER = getPublicKey(ZAPPER_SECRET);
const SENDER_SECRET = '88'.repeat(32);
const SENDER = getPublicKey(SENDER_SECRET);
const NODE_KEY = '99'.repeat(32);
const T0 = '2026-11-19T12:00:00Z';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const hashOf = (preimage: string) => bytesToHex(sha256(Buffer.from(preimage, 'hex')));

interface ZapOpts {
  sat?: number;
  requestMsat?: number | null;
  to?: string;
  requestTo?: string;
  signer?: string;
  preimage?: string;
  badPreimage?: boolean;
  createdAt?: number;
  comment?: string;
}

/** A NIP-57 zap receipt for `sat` sats, as an LNURL server would publish it. */
function zap(
  n: number,
  o: ZapOpts = {},
): { receipt: NostrEvent; paymentHash: string; preimage: string } {
  const sat = o.sat ?? 2100;
  const preimage = o.preimage ?? hex(1000 + n);
  const paymentHash = hashOf(preimage);
  const createdAt = o.createdAt ?? unixSeconds(new Date(T0)) - 60;
  const request = finalizeEvent(
    {
      kind: 9734,
      created_at: createdAt - 5,
      content: o.comment ?? 'Courage aux pêcheurs de Kayar',
      tags: [
        ['relays', 'wss://relay.example'],
        ...(o.requestMsat === null ? [] : [['amount', String(o.requestMsat ?? sat * 1000)]]),
        ['p', o.requestTo ?? POOL],
      ],
    },
    SENDER_SECRET,
  );
  const bolt11 = encodeBolt11({
    amountSat: sat,
    paymentHash,
    paymentSecret: hex(5000 + n),
    description: 'zap',
    timestamp: createdAt - 5,
    expirySec: 3600,
    nodeKey: NODE_KEY,
  });
  const receipt = finalizeEvent(
    {
      kind: 9735,
      created_at: createdAt,
      content: '',
      tags: [
        ['p', o.to ?? POOL],
        ['P', SENDER],
        ['bolt11', bolt11],
        ['description', JSON.stringify(request)],
        ['preimage', o.badPreimage ? '00'.repeat(32) : preimage],
      ],
    },
    o.signer ?? ZAPPER_SECRET,
  );
  return { receipt, paymentHash, preimage };
}

class StubZapSource implements ZapSource {
  events: NostrEvent[] = [];
  queries: { pubkey: string; since: number }[] = [];
  receipts(pubkey: string, since: number) {
    this.queries.push({ pubkey, since });
    return Promise.resolve(this.events.filter((e) => e.created_at >= since));
  }
}

/** A "real" (non-simulated) wallet whose lookups the test controls. */
class StubWallet implements Wallet {
  readonly kind = 'nwc' as const;
  readonly simulated = false;
  lookups = new Map<string, InvoiceLookup | Error>();
  balance = 0;
  makeInvoice(): never {
    throw new Error('offline');
  }
  payInvoice(): never {
    throw new Error('offline');
  }
  lookupInvoice(hash: string) {
    const l = this.lookups.get(hash) ?? { paid: false, state: 'not_found' as const };
    return l instanceof Error ? Promise.reject(l) : Promise.resolve(l);
  }
  getBalanceSat() {
    return Promise.resolve(this.balance);
  }
}

const priceFetch = (async () =>
  new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch;

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    ORACLE_SECRET: '11'.repeat(32),
    DEMO_ORACLE_SECRET: '22'.repeat(32),
    POOL_SECRET,
    SESSION_SECRET: '44'.repeat(32),
    PII_ENCRYPTION_KEY: '55'.repeat(32),
    DATABASE_PATH: '/nonexistent/ndox.sqlite',
    SEED_DIR: DEFAULT_PATHS.seedDir,
    POOL_LIGHTNING_ADDRESS: 'Caisse@Pool.Example',
    ...env,
  });
  const db = memoryDb();
  const t = settableClock(T0);
  const wallet = new StubWallet();
  const source = new StubZapSource();
  const services = createServices(config, db, silentLog, {
    clock: t.clock,
    liveSource: StubSource.constant({ ecmwf_wam: 1, ncep_gfswave025: 1 }),
    publisher: null,
    priceFetch,
    wallet,
    zapSource: source,
    zapperPubkey: () => Promise.resolve(ZAPPER),
  });
  const settle = (z: { paymentHash: string; preimage: string }, sat = 2100) =>
    wallet.lookups.set(z.paymentHash, {
      paid: true,
      state: 'settled',
      preimage: z.preimage,
      direction: 'incoming',
      amountSat: sat,
    });
  const zapRows = () => db.select().from(deposits).where(eq(deposits.kind, 'zap')).all();
  const ingest = () => services.money.zaps!.run(services.money, true);
  return { services, db, t, wallet, source, settle, zapRows, ingest };
}

describe('checkZapReceipt (NIP-57 Appendix F)', () => {
  const o = { poolPubkey: POOL, zapperPubkey: ZAPPER };

  it('accepts a well-formed receipt for the pool', () => {
    const z = zap(1);
    expect(checkZapReceipt(z.receipt, o)).toEqual({
      ok: true,
      paymentHash: z.paymentHash,
      amountMsat: 2_100_000,
      paidAt: z.receipt.created_at,
    });
    expect(checkZapReceipt(zap(2, { requestMsat: null }).receipt, o).ok).toBe(true);
  });

  it.each<[string, () => NostrEvent, string]>([
    [
      'another signer',
      () => zap(1, { signer: '66'.repeat(32) }).receipt,
      'receipt not signed by the LNURL server',
    ],
    ['another recipient', () => zap(1, { to: SENDER }).receipt, 'not for the pool'],
    [
      'a request for someone else',
      () => zap(1, { requestTo: SENDER }).receipt,
      'zap request not for the pool',
    ],
    [
      'an amount mismatch',
      () => zap(1, { requestMsat: 1000 }).receipt,
      'invoice amount differs from the zap request',
    ],
    ['a wrong preimage', () => zap(1, { badPreimage: true }).receipt, 'preimage does not match'],
    ['a tampered receipt', () => ({ ...zap(1).receipt, created_at: 1 }), 'bad receipt signature'],
    [
      'a tampered zap request',
      () => {
        const r = zap(1).receipt;
        const tags = r.tags.map((t) =>
          t[0] === 'description' ? ['description', t[1]!.replace('Courage', 'Merci')] : t,
        );
        return finalizeEvent(
          { kind: 9735, created_at: r.created_at, content: '', tags },
          ZAPPER_SECRET,
        );
      },
      'invalid zap request',
    ],
  ])('rejects %s', (_name, make, reason) => {
    expect(checkZapReceipt(make(), o)).toEqual({ ok: false, reason });
  });
});

describe('zap ingestion', () => {
  it('records a zap our wallet received, once, without the sender or the comment', async () => {
    const s = setup();
    expect(s.services.config.poolLightningAddress).toBe('caisse@pool.example');
    const z = zap(1);
    s.source.events.push(z.receipt);
    s.settle(z);
    expect(await s.ingest()).toEqual({ seen: 1, recorded: 1, rejected: 0, deferred: 0 });
    const rows = s.zapRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'zap',
      status: 'paid',
      amountSat: 2100,
      amountFcfa: 798,
      paymentHash: z.paymentHash,
      zapReceiptId: z.receipt.id,
      wallet: 'nwc',
      demo: false,
      paidAt: '2026-11-19T11:59:00Z',
    });
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${SENDER}|Courage`));
    // first look: a week back, plus the hour of overlap
    expect(s.source.queries[0]).toEqual({
      pubkey: POOL,
      since: unixSeconds(new Date(T0)) - 7 * 86_400 - 3600,
    });

    expect(await s.ingest()).toMatchObject({ recorded: 0 });
    expect(s.zapRows()).toHaveLength(1);
    // the cursor moved to the receipt, minus an hour of overlap
    expect(s.source.queries[1]!.since).toBe(z.receipt.created_at - 3600);
  });

  it('never counts a payment we made, an invoice we issued, or another wallet’s invoice', async () => {
    const s = setup();
    const outgoing = zap(1);
    const ours = zap(2);
    const elsewhere = zap(3);
    s.source.events.push(outgoing.receipt, ours.receipt, elsewhere.receipt);
    s.wallet.lookups.set(outgoing.paymentHash, {
      paid: true,
      state: 'settled',
      preimage: outgoing.preimage,
      direction: 'outgoing',
      amountSat: 2100,
    });
    s.settle(ours);
    s.db
      .insert(deposits)
      .values({
        id: 'dsponsor00001',
        kind: 'sponsor',
        status: 'pending',
        amountSat: 2100,
        paymentHash: ours.paymentHash,
        wallet: 'nwc',
        demo: false,
        createdAt: T0,
      })
      .run();
    expect(await s.ingest()).toEqual({ seen: 3, recorded: 0, rejected: 3, deferred: 0 });
    expect(s.zapRows()).toHaveLength(0);
  });

  it('waits for a pending invoice or an unreachable wallet, then records it', async () => {
    const s = setup();
    const z = zap(1);
    s.source.events.push(z.receipt);
    s.wallet.lookups.set(z.paymentHash, { paid: false, state: 'pending', direction: 'incoming' });
    expect(await s.ingest()).toMatchObject({ deferred: 1, recorded: 0 });
    s.wallet.lookups.set(z.paymentHash, new Error('relay timeout'));
    expect(await s.ingest()).toMatchObject({ deferred: 1, recorded: 0 });
    // the cursor never moves past a deferred receipt
    expect(s.source.queries.at(-1)!.since).toBeLessThanOrEqual(z.receipt.created_at);
    s.settle(z);
    expect(await s.ingest()).toMatchObject({ deferred: 0, recorded: 1 });
  });

  it('refuses a receipt whose amount differs from what the wallet received', async () => {
    const s = setup();
    const z = zap(1);
    s.source.events.push(z.receipt);
    s.settle(z, 21);
    expect(await s.ingest()).toMatchObject({ rejected: 1, recorded: 0 });
  });

  it('runs every five minutes from the scheduler, and only next to a real wallet', async () => {
    const s = setup();
    const z = zap(1);
    s.source.events.push(z.receipt);
    s.settle(z);
    expect((await runPayoutJobs(s.services.money)).zaps).toMatchObject({ recorded: 1 });
    s.t.set('2026-11-19T12:04:00Z');
    expect((await runPayoutJobs(s.services.money)).zaps).toBeNull();
    s.t.set('2026-11-19T12:05:00Z');
    expect((await runPayoutJobs(s.services.money)).zaps).toMatchObject({ seen: 1, recorded: 0 });

    const config = loadConfig({
      ORACLE_SECRET: '11'.repeat(32),
      DEMO_ORACLE_SECRET: '22'.repeat(32),
      POOL_SECRET,
      SESSION_SECRET: '44'.repeat(32),
      PII_ENCRYPTION_KEY: '55'.repeat(32),
      DATABASE_PATH: '/nonexistent/ndox.sqlite',
      POOL_LIGHTNING_ADDRESS: 'caisse@pool.example',
    });
    const fake = createServices(config, memoryDb(), silentLog, { publisher: null, priceFetch });
    expect(fake.money.zaps).toBeNull();
    expect(() => setup({ POOL_LIGHTNING_ADDRESS: 'not an address' })).toThrow(/Lightning address/);
  });

  it('reads the LNURL server key from the pool address (LUD-16)', async () => {
    const urls: string[] = [];
    const answer = (body: object) =>
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify(body));
      }) as typeof fetch;
    expect(
      await fetchZapperPubkey(
        'caisse@pool.example',
        answer({ allowsNostr: true, nostrPubkey: ZAPPER }),
      ),
    ).toBe(ZAPPER);
    expect(urls).toEqual(['https://pool.example/.well-known/lnurlp/caisse']);
    await expect(
      fetchZapperPubkey('caisse@pool.example', answer({ allowsNostr: false, nostrPubkey: ZAPPER })),
    ).rejects.toThrow(/allowsNostr/);
    await expect(
      fetchZapperPubkey('caisse@pool.example', answer({ allowsNostr: true, nostrPubkey: 'zz' })),
    ).rejects.toThrow(/nostrPubkey/);

    const w = new ZapWatcher({
      source: new StubZapSource(),
      address: 'caisse@pool.example',
      zapperPubkey: () => Promise.reject(new Error('LNURL server answered 500')),
    });
    const s = setup();
    await expect(w.run(s.services.money)).rejects.toThrow(/500/);
  });
});

describe('pool profile (kind 0)', () => {
  class RecordingPublisher implements Publisher {
    events: NostrEvent[] = [];
    ok = true;
    publish(ev: NostrEvent): Promise<PublishResult> {
      this.events.push(ev);
      return Promise.resolve({
        ok: this.ok,
        accepted: this.ok ? ['wss://a', 'wss://b'] : [],
        rejected: [],
        at: '',
      });
    }
  }

  it('publishes the lud16 once, again when it changes, and retries a failed publish', async () => {
    const s = setup();
    const pub = new RecordingPublisher();
    const ctx = { ...s.services.money, publisher: pub };
    const site = { lud16: 'caisse@pool.example', website: 'https://ndox.example.com' };
    expect(await publishPoolProfile(ctx, site)).toBe(true);
    expect(pub.events[0]).toMatchObject({ kind: 0, pubkey: POOL });
    expect(JSON.parse(pub.events[0]!.content)).toMatchObject({
      lud16: 'caisse@pool.example',
      website: 'https://ndox.example.com',
    });
    expect(await publishPoolProfile(ctx, site)).toBe(false);
    expect(pub.events).toHaveLength(1);

    pub.ok = false;
    expect(await publishPoolProfile(ctx, { ...site, lud16: 'autre@pool.example' })).toBe(false);
    expect(pub.events).toHaveLength(2);
    s.t.set('2026-11-19T12:03:00Z');
    expect(await publishPoolProfile(ctx, { ...site, lud16: 'autre@pool.example' })).toBe(false);
    expect(pub.events).toHaveLength(2);
    pub.ok = true;
    s.t.set('2026-11-19T12:06:00Z');
    expect(await publishPoolProfile(ctx, { ...site, lud16: 'autre@pool.example' })).toBe(true);
    // the same signed event is re-sent, not a new one
    expect(pub.events[2]!.id).toBe(pub.events[1]!.id);
    expect(await publishPoolProfile({ ...ctx, publisher: null }, site)).toBe(false);
  });
});
