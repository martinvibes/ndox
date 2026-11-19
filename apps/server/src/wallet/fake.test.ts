import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { fakeInvoices } from '../db/schema.js';
import { memoryDb, settableClock } from '../test/helpers.js';
import { FakeLnAddressResolver, FakeWallet } from './fake.js';

const SEED = '5a'.repeat(32);

function setup(start = '2026-11-19T12:00:00Z') {
  const db = memoryDb();
  const t = settableClock(start);
  const pool = new FakeWallet({ db, seed: SEED, account: 'pool', clock: t.clock });
  const resolver = new FakeLnAddressResolver({ db, seed: SEED, clock: t.clock });
  return { db, t, pool, resolver };
}

const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));

describe('FakeWallet', () => {
  it('issues deterministic, decodable regtest invoices whose preimage hashes to the payment hash', async () => {
    const a = setup();
    const b = setup();
    const inv = await a.pool.makeInvoice(5262, 'Prime Ndox', 600);
    expect(inv).toEqual(await b.pool.makeInvoice(5262, 'Prime Ndox', 600));
    expect(inv.invoice.startsWith('lnbcrt')).toBe(true);
    expect(inv.expiresAt).toBe('2026-11-19T12:10:00Z');
    expect(decodeInvoice(inv.invoice)).toMatchObject({
      paymentHash: inv.paymentHash,
      satoshi: 5262,
      description: 'Prime Ndox',
      expiry: 600,
    });
    expect(await a.pool.lookupInvoice(inv.paymentHash)).toEqual({ paid: false, state: 'pending' });
    expect(a.pool.simulated).toBe(true);
  });

  it('settles its own invoice on a simulated payment, exactly once', async () => {
    const { pool } = setup();
    const inv = await pool.makeInvoice(10_000, 'Versement caisse CLPA');
    expect(await pool.getBalanceSat()).toBe(0);
    expect(pool.simulatePayment(inv.paymentHash)).toBe(true);
    expect(pool.simulatePayment(inv.paymentHash)).toBe(false);
    const l = await pool.lookupInvoice(inv.paymentHash);
    expect(l).toMatchObject({ paid: true, state: 'settled' });
    expect(hashOf(l.preimage!)).toBe(inv.paymentHash);
    expect(await pool.getBalanceSat()).toBe(10_000);
  });

  it('pays an invoice from a (fake) Lightning address and reveals the right preimage', async () => {
    const { pool, resolver } = setup();
    pool.simulatePayment((await pool.makeInvoice(20_000, 'fonds')).paymentHash);
    const req = await resolver.requestInvoice('kayar-01@demo.ndox.invalid', 5262, 'Ndox');
    expect(decodeInvoice(req.invoice)?.satoshi).toBe(5262);

    const paid = await pool.payInvoice(req.invoice);
    expect(hashOf(paid.preimage)).toBe(req.paymentHash);
    expect(paid.feeSat).toBe(0);
    expect(await pool.getBalanceSat()).toBe(20_000 - 5262);
    expect(await pool.lookupInvoice(req.paymentHash)).toMatchObject({
      paid: true,
      state: 'settled',
      preimage: paid.preimage,
    });
  });

  it('refuses double payment, insufficient balance, expired, own and unknown invoices', async () => {
    const { pool, resolver, t } = setup();
    pool.simulatePayment((await pool.makeInvoice(6000, 'fonds')).paymentHash);
    const a = await resolver.requestInvoice('a@demo.ndox.invalid', 5000);
    await pool.payInvoice(a.invoice);
    await expect(pool.payInvoice(a.invoice)).rejects.toThrow(/already paid/);

    const b = await resolver.requestInvoice('b@demo.ndox.invalid', 5000);
    await expect(pool.payInvoice(b.invoice)).rejects.toThrow(/insufficient balance/);
    expect(await pool.getBalanceSat()).toBe(1000);
    expect(await pool.lookupInvoice(b.paymentHash)).toEqual({ paid: false, state: 'not_found' });

    const c = await resolver.requestInvoice('c@demo.ndox.invalid', 10);
    t.set('2026-11-19T13:00:01Z');
    await expect(pool.payInvoice(c.invoice)).rejects.toThrow(/expired/);

    const own = await pool.makeInvoice(10, 'self');
    await expect(pool.payInvoice(own.invoice)).rejects.toThrow(/own invoice/);
    await expect(pool.payInvoice('lnbc10n1notaninvoice')).rejects.toThrow(/invalid invoice/);
  });

  it('reports an expired unpaid incoming invoice as failed', async () => {
    const { pool, t } = setup();
    const inv = await pool.makeInvoice(100, 'x', 60);
    t.set('2026-11-19T12:01:00Z');
    expect(await pool.lookupInvoice(inv.paymentHash)).toEqual({ paid: false, state: 'failed' });
    expect(pool.simulatePayment(inv.paymentHash)).toBe(false);
  });

  it('keeps accounts separate (replay wallets never touch the pool)', async () => {
    const { db, pool, resolver, t } = setup();
    pool.simulatePayment((await pool.makeInvoice(50_000, 'fonds')).paymentHash);
    const replay = new FakeWallet({
      db,
      seed: SEED,
      account: 'replay:r1',
      clock: t.clock,
      openingSat: 30_000,
    });
    expect(await replay.getBalanceSat()).toBe(30_000);
    await replay.payInvoice((await resolver.requestInvoice('k@demo.ndox.invalid', 5000)).invoice);
    expect(await replay.getBalanceSat()).toBe(25_000);
    expect(await pool.getBalanceSat()).toBe(50_000);
  });

  it('persists its ledger across restarts without reusing payment hashes', async () => {
    const { db, pool, t } = setup();
    const first = await pool.makeInvoice(1, 'a');
    const again = new FakeWallet({ db, seed: SEED, account: 'pool', clock: t.clock });
    const second = await again.makeInvoice(1, 'a');
    expect(second.paymentHash).not.toBe(first.paymentHash);
    again.simulatePayment(first.paymentHash);
    expect(await pool.getBalanceSat()).toBe(1);
  });

  it('never stores a Lightning address in clear', async () => {
    const { db, resolver } = setup();
    await resolver.requestInvoice('secret-crew@demo.ndox.invalid', 21, 'Ndox');
    const rows = JSON.stringify(db.select().from(fakeInvoices).all());
    expect(rows).not.toContain('secret-crew');
    expect(rows).toContain('"account":"ext:');
  });
});
