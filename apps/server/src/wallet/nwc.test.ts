import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { settableClock } from '../test/helpers.js';
import { encodeBolt11 } from './bolt11.js';
import { LnurlResolver, type LightningAddressLike } from './lnaddress.js';
import { NwcWallet, type NwcClientLike } from './nwc.js';

const preimage = '7e'.repeat(32);
const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
const invoice = encodeBolt11({
  amountSat: 5262,
  paymentHash,
  paymentSecret: '11'.repeat(32),
  description: 'Ndox',
  timestamp: 1_795_000_000,
  expirySec: 3600,
  nodeKey: '22'.repeat(32),
});

class StubClient implements NwcClientLike {
  calls: [string, unknown][] = [];
  lookup: () => Promise<Record<string, unknown>> = async () => ({});
  pay: () => Promise<{ preimage: string; fees_paid: number }> = async () => ({
    preimage,
    fees_paid: 1500,
  });
  closed = false;
  async makeInvoice(r: { amount: number; description?: string; expiry?: number }) {
    this.calls.push(['makeInvoice', r]);
    return { invoice, payment_hash: paymentHash, expires_at: 1_795_003_600 };
  }
  async payInvoice(r: { invoice: string }) {
    this.calls.push(['payInvoice', r]);
    return this.pay();
  }
  async lookupInvoice(r: { payment_hash?: string }) {
    this.calls.push(['lookupInvoice', r]);
    return this.lookup();
  }
  async getBalance() {
    return { balance: 123_456_789 };
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const client = new StubClient();
  const t = settableClock('2026-11-19T12:00:00Z');
  const w = new NwcWallet({ client, clock: t.clock });
  return { client, w, t };
}

describe('NwcWallet (NIP-47 via @getalby/sdk, millisats on the wire)', () => {
  it('converts sats to msats for invoices and msats to whole sats for the balance', async () => {
    const { client, w } = setup();
    expect(await w.makeInvoice(5262, 'Prime', 900)).toEqual({
      invoice,
      paymentHash,
      expiresAt: '2026-11-18T12:06:40Z',
    });
    expect(client.calls[0]).toEqual([
      'makeInvoice',
      { amount: 5_262_000, description: 'Prime', expiry: 900 },
    ]);
    expect(await w.getBalanceSat()).toBe(123_456); // floor(123456789 msat / 1000)
    expect(w.simulated).toBe(false);
    w.close();
    expect(client.closed).toBe(true);
  });

  it('pays, checks the preimage against the invoice hash and rounds fees up to whole sats', async () => {
    const { client, w } = setup();
    expect(await w.payInvoice(invoice)).toEqual({ preimage, feeSat: 2 });
    client.pay = async () => ({ preimage: '00'.repeat(32), fees_paid: 0 });
    await expect(w.payInvoice(invoice)).rejects.toThrow(/preimage does not match/);
    await expect(w.payInvoice('not-an-invoice')).rejects.toThrow(/invalid invoice/);
  });

  it('maps NIP-47 transaction states and NOT_FOUND errors', async () => {
    const { client, w, t } = setup();
    client.lookup = async () => ({ state: 'settled', preimage, payment_hash: paymentHash });
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: true, state: 'settled', preimage });
    expect(client.calls.at(-1)).toEqual(['lookupInvoice', { payment_hash: paymentHash }]);

    client.lookup = async () => ({
      type: 'incoming',
      amount: 5_262_999,
      state: 'settled',
      preimage,
    });
    expect(await w.lookupInvoice(paymentHash)).toEqual({
      paid: true,
      state: 'settled',
      preimage,
      direction: 'incoming',
      amountSat: 5262,
    });
    client.lookup = async () => ({ type: 'sideways', amount: -1, state: 'failed' });
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: false, state: 'failed' });

    client.lookup = async () => ({ state: 'pending', preimage: '' });
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: false, state: 'pending' });
    client.lookup = async () => ({ state: 'accepted' });
    expect((await w.lookupInvoice(paymentHash)).state).toBe('pending');
    client.lookup = async () => ({ state: 'failed' });
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: false, state: 'failed' });

    // wallets without `state`: settled_at, then expiry
    client.lookup = async () => ({ settled_at: 1_795_000_100, preimage });
    expect((await w.lookupInvoice(paymentHash)).state).toBe('settled');
    client.lookup = async () => ({ settled_at: 0, preimage: '', expires_at: 1_795_000_000 });
    t.set('2026-11-19T12:00:00Z');
    expect((await w.lookupInvoice(paymentHash)).state).toBe('failed');

    // a settled answer with a wrong preimage is not trusted
    client.lookup = async () => ({ state: 'settled', preimage: '00'.repeat(32) });
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: false, state: 'pending' });

    client.lookup = async () => {
      throw Object.assign(new Error('invoice not found'), { code: 'NOT_FOUND' });
    };
    expect(await w.lookupInvoice(paymentHash)).toEqual({ paid: false, state: 'not_found' });
    client.lookup = async () => {
      throw Object.assign(new Error('reply timeout'), { code: 'INTERNAL' });
    };
    await expect(w.lookupInvoice(paymentHash)).rejects.toThrow(/reply timeout/);
  });
});

class StubAddress implements LightningAddressLike {
  lnurlpData: { min: number; max: number; commentAllowed?: number } | undefined;
  requested: { satoshi: number; comment?: string }[] = [];
  constructor(
    private readonly respond: (sat: number) => string,
    data: StubAddress['lnurlpData'] = { min: 1000, max: 1_000_000_000, commentAllowed: 0 },
  ) {
    this.lnurlpData = data;
  }
  async fetch() {}
  async requestInvoice(args: { satoshi: number; comment?: string }) {
    this.requested.push(args);
    return { paymentRequest: this.respond(args.satoshi) };
  }
}

describe('LnurlResolver (@getalby/lightning-tools, no proxy)', () => {
  it('returns the invoice, its hash and expiry, and omits comments the service does not accept', async () => {
    const addr = new StubAddress(() => invoice);
    const seen: string[] = [];
    const r = new LnurlResolver({
      factory: (a) => {
        seen.push(a);
        return addr;
      },
    });
    expect(await r.requestInvoice('crew@wallet.example', 5262, 'Ndox paiement')).toEqual({
      invoice,
      paymentHash,
      expiresAt: '2026-11-18T12:06:40Z',
    });
    expect(seen).toEqual(['crew@wallet.example']);
    expect(addr.requested).toEqual([{ satoshi: 5262 }]);

    const withComments = new StubAddress(() => invoice, { min: 1, max: 1e12, commentAllowed: 64 });
    await new LnurlResolver({ factory: () => withComments }).requestInvoice(
      'a@b.example',
      5262,
      'Ndox',
    );
    expect(withComments.requested).toEqual([{ satoshi: 5262, comment: 'Ndox' }]);
  });

  it('rejects an invoice for a different amount and never puts the address in errors', async () => {
    const wrong = new LnurlResolver({ factory: () => new StubAddress(() => invoice) });
    await expect(wrong.requestInvoice('crew@wallet.example', 5000)).rejects.toThrow(
      /amount mismatch/,
    );

    const broken = new LnurlResolver({
      factory: () => ({
        lnurlpData: undefined,
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND wallet.example for crew@wallet.example');
        },
        requestInvoice: async () => ({ paymentRequest: '' }),
      }),
    });
    const err = await broken.requestInvoice('crew@wallet.example', 5262).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('crew');
    expect((err as Error).message).not.toContain('wallet.example');
  });

  it('times out slow LNURL servers', async () => {
    const slow = new LnurlResolver({
      timeoutMs: 20,
      factory: () => ({
        lnurlpData: undefined,
        fetch: () => new Promise<void>(() => {}),
        requestInvoice: async () => ({ paymentRequest: '' }),
      }),
    });
    await expect(slow.requestInvoice('a@b.example', 10)).rejects.toThrow(/timed out/);
  });
});
