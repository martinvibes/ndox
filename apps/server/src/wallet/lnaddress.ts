/**
 * Lightning address → invoice (LNURL-pay, LUD-06/16) via @getalby/lightning-tools 10.0.0.
 * `LightningAddress` proxies through api.getalby.com by default; we pass `proxy: false` so a
 * crew's address is only ever sent to its own wallet provider. `requestInvoice` checks the
 * amount against the service's min/max and that the returned invoice is for exactly that amount;
 * we decode it once more before storing it.
 *
 * Errors never contain the address (it is personal data).
 */
import { LightningAddress } from '@getalby/lightning-tools/lnurl';
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { isoSeconds } from '../lib/time.js';
import type { LnAddressResolver } from './types.js';

/** The subset of LightningAddress used here. */
export interface LightningAddressLike {
  lnurlpData: { commentAllowed?: number } | undefined;
  fetch(): Promise<void>;
  requestInvoice(args: { satoshi: number; comment?: string }): Promise<{ paymentRequest: string }>;
}

export class LnAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LnAddressError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LnAddressError(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function scrub(message: string, address: string): string {
  let out = message;
  const [user, domain] = address.split('@');
  for (const s of [address, user, domain]) if (s) out = out.split(s).join('…');
  return out.slice(0, 200);
}

export class LnurlResolver implements LnAddressResolver {
  private readonly timeoutMs: number;
  private readonly factory: (address: string) => LightningAddressLike;

  constructor(o: { timeoutMs?: number; factory?: (address: string) => LightningAddressLike } = {}) {
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.factory = o.factory ?? ((a) => new LightningAddress(a, { proxy: false }));
  }

  async requestInvoice(
    address: string,
    amountSat: number,
    comment?: string,
  ): Promise<{ invoice: string; paymentHash: string; expiresAt: string }> {
    try {
      const la = this.factory(address);
      await withTimeout(la.fetch(), this.timeoutMs, 'lightning address lookup');
      if (!la.lnurlpData) throw new LnAddressError('lightning address has no LNURL-pay endpoint');
      const allowed = la.lnurlpData.commentAllowed ?? 0;
      const args =
        comment && allowed >= comment.length
          ? { satoshi: amountSat, comment }
          : { satoshi: amountSat };
      const inv = await withTimeout(la.requestInvoice(args), this.timeoutMs, 'invoice request');
      const d = decodeInvoice(inv.paymentRequest);
      if (!d) throw new LnAddressError('LNURL service returned an invalid invoice');
      if (d.millisatoshi !== amountSat * 1000)
        throw new LnAddressError(
          `invoice amount mismatch (${d.millisatoshi} msat, expected ${amountSat * 1000})`,
        );
      // BOLT11: expiry defaults to 3600 s when the invoice has no `x` field
      const expiresAt = isoSeconds(new Date((d.timestamp + (d.expiry ?? 3600)) * 1000));
      return { invoice: inv.paymentRequest, paymentHash: d.paymentHash, expiresAt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LnAddressError(scrub(msg, address));
    }
  }
}
