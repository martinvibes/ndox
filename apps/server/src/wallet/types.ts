/**
 * Wallet adapters (docs/BRIEF.md §8). Amounts are integer sats at this boundary; the NWC adapter
 * converts to and from millisats.
 */

/**
 * What the wallet knows about a payment hash, incoming or outgoing.
 *  - settled:   paid (preimage known)
 *  - pending:   in flight or unpaid but still payable; never retry while pending
 *  - failed:    definitely not paid (failed payment, or expired unpaid invoice)
 *  - not_found: the wallet has no record of it
 */
export type LookupState = 'settled' | 'pending' | 'failed' | 'not_found';

export interface InvoiceLookup {
  paid: boolean;
  state: LookupState;
  preimage?: string;
}

export interface CreatedInvoice {
  invoice: string;
  paymentHash: string;
  /** ISO time after which the invoice can no longer be paid. */
  expiresAt: string;
}

export interface Wallet {
  readonly kind: 'fake' | 'nwc';
  /** True for FakeWallet: everything it does is shown with the "Simulé" badge. */
  readonly simulated: boolean;
  makeInvoice(amountSat: number, memo: string, expirySec?: number): Promise<CreatedInvoice>;
  /** Resolves only when the payment settled; the preimage is checked against the hash. */
  payInvoice(invoice: string): Promise<{ preimage: string; feeSat: number }>;
  lookupInvoice(paymentHash: string): Promise<InvoiceLookup>;
  getBalanceSat(): Promise<number>;
  close?(): void;
}

/** Turns a crew's Lightning address into an invoice for exactly `amountSat` (LNURL-pay). */
export interface LnAddressResolver {
  requestInvoice(
    address: string,
    amountSat: number,
    comment?: string,
  ): Promise<{ invoice: string; paymentHash: string; expiresAt: string }>;
}

export const DEFAULT_INVOICE_EXPIRY_SEC = 3600;
