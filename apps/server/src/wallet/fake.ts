/**
 * FakeWallet (docs/BRIEF.md §8): a deterministic simulated Lightning wallet, labelled "Simulé"
 * everywhere it shows up. Invoices are real signed BOLT11 strings on the regtest prefix whose
 * preimage hashes to the payment hash, so the payout engine, receipts and the public verifier
 * work exactly as with a real wallet. The ledger lives in SQLite (fake_invoices) so the demo pool
 * balance survives restarts. Several accounts share it: the pool, each replay run, and the demo
 * crews' Lightning addresses (FakeLnAddressResolver).
 */
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { and, eq, max, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { fakeInvoices } from '../db/schema.js';
import { isoSeconds, unixSeconds, type Clock } from '../lib/time.js';
import { encodeBolt11, FAKE_HRP } from './bolt11.js';
import {
  DEFAULT_INVOICE_EXPIRY_SEC,
  type CreatedInvoice,
  type InvoiceLookup,
  type LnAddressResolver,
  type Wallet,
} from './types.js';

export class FakeWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeWalletError';
  }
}

interface LedgerOptions {
  db: Db;
  /** 32-byte hex seed; every key, preimage and secret is derived from it. */
  seed: string;
  clock: Clock;
}

function derive(seed: string, label: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(seed), utf8ToBytes(label)));
}

/** Issues an invoice for `account` in the shared ledger (synchronous, so it is atomic). */
function issue(
  o: LedgerOptions,
  account: string,
  amountSat: number,
  memo: string,
  expirySec: number,
): CreatedInvoice {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0)
    throw new FakeWalletError('amount must be a positive integer number of sats');
  if (!Number.isSafeInteger(expirySec) || expirySec <= 0)
    throw new FakeWalletError('expiry must be a positive integer');
  const now = o.clock();
  return o.db.transaction((tx) => {
    const last = tx
      .select({ seq: max(fakeInvoices.seq) })
      .from(fakeInvoices)
      .where(eq(fakeInvoices.account, account))
      .get();
    const seq = (last?.seq ?? 0) + 1;
    const preimage = derive(o.seed, `preimage:${account}:${seq}`);
    const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
    const invoice = encodeBolt11({
      amountSat,
      paymentHash,
      paymentSecret: derive(o.seed, `secret:${account}:${seq}`),
      description: memo,
      timestamp: unixSeconds(now),
      expirySec,
      nodeKey: derive(o.seed, `node:${account}`),
    });
    const expiresAt = isoSeconds(new Date(now.getTime() + expirySec * 1000));
    tx.insert(fakeInvoices)
      .values({
        paymentHash,
        account,
        seq,
        invoice,
        preimage,
        amountSat,
        memo,
        createdAt: isoSeconds(now),
        expiresAt,
      })
      .run();
    return { invoice, paymentHash, expiresAt };
  });
}

export interface FakeWalletOptions extends LedgerOptions {
  /** 'pool', 'replay:<runId>', … */
  account: string;
  /** Starting balance (replay wallets start from a snapshot of the pool). */
  openingSat?: number;
}

export class FakeWallet implements Wallet {
  readonly kind = 'fake' as const;
  readonly simulated = true;

  constructor(private readonly o: FakeWalletOptions) {
    if (o.account.startsWith('ext:')) throw new FakeWalletError('ext: accounts are reserved');
  }

  get account(): string {
    return this.o.account;
  }

  async makeInvoice(
    amountSat: number,
    memo: string,
    expirySec = DEFAULT_INVOICE_EXPIRY_SEC,
  ): Promise<CreatedInvoice> {
    return issue(this.o, this.o.account, amountSat, memo, expirySec);
  }

  async payInvoice(invoice: string): Promise<{ preimage: string; feeSat: number }> {
    const decoded = invoice.startsWith(FAKE_HRP) ? decodeInvoice(invoice) : null;
    if (!decoded)
      throw new FakeWalletError('invalid invoice (FakeWallet pays only lnbcrt invoices)');
    const now = this.o.clock();
    return this.o.db.transaction((tx) => {
      const row = tx
        .select()
        .from(fakeInvoices)
        .where(eq(fakeInvoices.paymentHash, decoded.paymentHash))
        .get();
      if (!row || row.invoice !== invoice)
        throw new FakeWalletError('no route to destination (unknown invoice)');
      if (row.account === this.o.account) throw new FakeWalletError('cannot pay own invoice');
      if (row.status === 'paid') throw new FakeWalletError('invoice already paid');
      if (now >= new Date(row.expiresAt)) throw new FakeWalletError('invoice expired');
      if (this.balance(tx) < row.amountSat) throw new FakeWalletError('insufficient balance');
      const res = tx
        .update(fakeInvoices)
        .set({ status: 'paid', paidAt: isoSeconds(now), paidBy: this.o.account })
        .where(and(eq(fakeInvoices.paymentHash, row.paymentHash), eq(fakeInvoices.status, 'open')))
        .run();
      if (res.changes !== 1) throw new FakeWalletError('invoice already paid');
      return { preimage: row.preimage, feeSat: 0 };
    });
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceLookup> {
    const row = this.o.db
      .select()
      .from(fakeInvoices)
      .where(eq(fakeInvoices.paymentHash, paymentHash))
      .get();
    if (row && row.account === this.o.account) {
      const meta = { direction: 'incoming' as const, amountSat: row.amountSat };
      if (row.status === 'paid')
        return { paid: true, state: 'settled', preimage: row.preimage, ...meta };
      return this.o.clock() >= new Date(row.expiresAt)
        ? { paid: false, state: 'failed', ...meta }
        : { paid: false, state: 'pending', ...meta };
    }
    if (row && row.paidBy === this.o.account)
      return {
        paid: true,
        state: 'settled',
        preimage: row.preimage,
        direction: 'outgoing',
        amountSat: row.amountSat,
      };
    return { paid: false, state: 'not_found' };
  }

  async getBalanceSat(): Promise<number> {
    return this.balance(this.o.db);
  }

  /**
   * Demo only ("Simuler le paiement"): marks one of this account's open invoices as paid by an
   * outside payer. Returns false if it was already paid, expired or not ours.
   */
  simulatePayment(paymentHash: string): boolean {
    const now = isoSeconds(this.o.clock());
    const res = this.o.db
      .update(fakeInvoices)
      .set({ status: 'paid', paidAt: now, paidBy: 'simulated' })
      .where(
        and(
          eq(fakeInvoices.paymentHash, paymentHash),
          eq(fakeInvoices.account, this.o.account),
          eq(fakeInvoices.status, 'open'),
          sql`${fakeInvoices.expiresAt} > ${now}`,
        ),
      )
      .run();
    return res.changes === 1;
  }

  private balance(db: Pick<Db, 'select'>): number {
    const incoming = db
      .select({ s: sum(fakeInvoices.amountSat) })
      .from(fakeInvoices)
      .where(and(eq(fakeInvoices.account, this.o.account), eq(fakeInvoices.status, 'paid')))
      .get();
    const outgoing = db
      .select({ s: sum(fakeInvoices.amountSat) })
      .from(fakeInvoices)
      .where(eq(fakeInvoices.paidBy, this.o.account))
      .get();
    return (this.o.openingSat ?? 0) + Number(incoming?.s ?? 0) - Number(outgoing?.s ?? 0);
  }
}

/**
 * LNURL-pay stand-in for FakeWallet mode: any Lightning address gets an invoice from its own fake
 * account. No network call is made, and the address is only stored as a hash.
 */
export class FakeLnAddressResolver implements LnAddressResolver {
  constructor(private readonly o: LedgerOptions) {}

  async requestInvoice(
    address: string,
    amountSat: number,
    comment?: string,
  ): Promise<{ invoice: string; paymentHash: string; expiresAt: string }> {
    const account = `ext:${bytesToHex(sha256(utf8ToBytes(address.trim().toLowerCase()))).slice(0, 16)}`;
    return issue(this.o, account, amountSat, comment ?? '', DEFAULT_INVOICE_EXPIRY_SEC);
  }
}
