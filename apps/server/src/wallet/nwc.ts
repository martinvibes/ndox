/**
 * Nostr Wallet Connect wallet (NIP-47) via @getalby/sdk's NWCClient. NIP-47 amounts are millisats;
 * this adapter speaks whole sats. Verified against @getalby/sdk 9.0.0 (types + docs/nwc.md):
 * makeInvoice({ amount msat, description, expiry }) → Nip47Transaction, payInvoice({ invoice }) →
 * { preimage, fees_paid msat }, lookupInvoice({ payment_hash }) → Nip47Transaction (state
 * settled|pending|failed|accepted), getBalance() → { balance msat }. "Not found" arrives as a
 * Nip47WalletError with code NOT_FOUND.
 *
 * The connection should carry a wallet-side budget; the app enforces DAILY_PAYOUT_CAP_SATS too.
 */
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { NWCClient } from '@getalby/sdk/nwc';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isoSeconds, systemClock, type Clock } from '../lib/time.js';
import {
  DEFAULT_INVOICE_EXPIRY_SEC,
  type CreatedInvoice,
  type InvoiceLookup,
  type Wallet,
} from './types.js';

/** The subset of NWCClient this adapter uses (lets tests inject a stub). */
export interface NwcClientLike {
  makeInvoice(r: {
    amount: number;
    description?: string;
    expiry?: number;
  }): Promise<{ invoice: string; payment_hash: string; expires_at?: number }>;
  payInvoice(r: { invoice: string }): Promise<{ preimage: string; fees_paid?: number }>;
  lookupInvoice(r: { payment_hash: string }): Promise<{
    type?: string;
    /** msat */
    amount?: number;
    state?: string;
    preimage?: string;
    settled_at?: number;
    expires_at?: number;
  }>;
  getBalance(): Promise<{ balance: number }>;
  close(): void;
}

const HEX32 = /^[0-9a-f]{64}$/;

export function preimageMatches(preimage: string | undefined, paymentHash: string): boolean {
  if (!preimage || !HEX32.test(preimage.toLowerCase())) return false;
  return bytesToHex(sha256(hexToBytes(preimage.toLowerCase()))) === paymentHash.toLowerCase();
}

export class NwcWallet implements Wallet {
  readonly kind = 'nwc' as const;
  readonly simulated = false;
  private client: NwcClientLike | null;
  private readonly clock: Clock;

  constructor(private readonly o: { url?: string; client?: NwcClientLike; clock?: Clock }) {
    if (!o.client && !o.url) throw new Error('NwcWallet needs NWC_URL');
    this.client = o.client ?? null;
    this.clock = o.clock ?? systemClock;
  }

  private nwc(): NwcClientLike {
    this.client ??= new NWCClient({ nostrWalletConnectUrl: this.o.url });
    return this.client;
  }

  async makeInvoice(
    amountSat: number,
    memo: string,
    expirySec = DEFAULT_INVOICE_EXPIRY_SEC,
  ): Promise<CreatedInvoice> {
    const amount = amountSat * 1000;
    if (!Number.isSafeInteger(amountSat) || amountSat <= 0 || !Number.isSafeInteger(amount))
      throw new RangeError('amountSat must be a positive integer');
    const tx = await this.nwc().makeInvoice({ amount, description: memo, expiry: expirySec });
    const expires = tx.expires_at
      ? new Date(tx.expires_at * 1000)
      : new Date(this.clock().getTime() + expirySec * 1000);
    return { invoice: tx.invoice, paymentHash: tx.payment_hash, expiresAt: isoSeconds(expires) };
  }

  async payInvoice(invoice: string): Promise<{ preimage: string; feeSat: number }> {
    const decoded = decodeInvoice(invoice);
    if (!decoded) throw new Error('invalid invoice');
    const res = await this.nwc().payInvoice({ invoice });
    if (!preimageMatches(res.preimage, decoded.paymentHash))
      throw new Error('wallet preimage does not match the payment hash');
    return { preimage: res.preimage.toLowerCase(), feeSat: Math.ceil((res.fees_paid ?? 0) / 1000) };
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceLookup> {
    let tx: Awaited<ReturnType<NwcClientLike['lookupInvoice']>>;
    try {
      tx = await this.nwc().lookupInvoice({ payment_hash: paymentHash });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'NOT_FOUND')
        return { paid: false, state: 'not_found' };
      throw err;
    }
    const settled = tx.state === 'settled' || (tx.state === undefined && (tx.settled_at ?? 0) > 0);
    const meta: Pick<InvoiceLookup, 'direction' | 'amountSat'> = {
      ...(tx.type === 'incoming' || tx.type === 'outgoing'
        ? { direction: tx.type as 'incoming' | 'outgoing' }
        : {}),
      ...(Number.isSafeInteger(tx.amount) && tx.amount! >= 0
        ? { amountSat: Math.floor(tx.amount! / 1000) }
        : {}),
    };
    if (settled) {
      // a "settled" answer we cannot check is re-asked later rather than trusted
      return preimageMatches(tx.preimage, paymentHash)
        ? { paid: true, state: 'settled', preimage: tx.preimage!.toLowerCase(), ...meta }
        : { paid: false, state: 'pending', ...meta };
    }
    if (tx.state === 'failed') return { paid: false, state: 'failed', ...meta };
    if (
      tx.state === undefined &&
      tx.expires_at !== undefined &&
      tx.expires_at * 1000 <= this.clock().getTime()
    )
      return { paid: false, state: 'failed', ...meta };
    return { paid: false, state: 'pending', ...meta };
  }

  async getBalanceSat(): Promise<number> {
    const { balance } = await this.nwc().getBalance();
    return Math.floor(balance / 1000);
  }

  close(): void {
    this.client?.close();
  }
}
