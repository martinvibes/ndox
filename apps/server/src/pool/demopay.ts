/**
 * The demo "pay this invoice" button (sponsor page, council premium panel), in the two modes where
 * it exists:
 *  - simulate: WALLET_MODE=fake, FakeWallet marks the invoice paid (no Lightning at all);
 *  - test:     an NWC wallet on a test network, TEST_PAYER_NWC_URL pays the invoice over real
 *              Lightning with sats that have no value.
 * With a mainnet wallet there is no button: config refuses a test payer on mainnet.
 */
import { errorMessage } from '../lib/log.js';
import { FakeWallet } from '../wallet/fake.js';
import { refreshDeposit, type DepositRow, type MoneyCtx } from './deposits.js';

export type DemoPayMode = 'simulate' | 'test' | null;

export function demoPayMode(
  ctx: Pick<MoneyCtx, 'wallet' | 'testFunds' | 'testPayer'>,
): DemoPayMode {
  if (ctx.wallet instanceof FakeWallet) return 'simulate';
  if (ctx.testFunds && ctx.testPayer) return 'test';
  return null;
}

/** Hashes being paid right now: a double press must not send a second payment. */
const inFlight = new Set<string>();

/**
 * Pays a pending deposit invoice the demo way, then refreshes it from the pool wallet.
 *  - ok:          paid now, already settled earlier, or a payment is already on its way
 *  - not_payable: no demo payment in this mode, or the invoice cannot be paid (expired, unknown)
 *  - failed:      the test payer tried and the payment failed (e.g. the payer ran dry)
 */
export async function payDemoDeposit(
  ctx: MoneyCtx,
  d: DepositRow,
): Promise<'ok' | 'not_payable' | 'failed'> {
  const hash = d.paymentHash;
  if (!hash) return 'not_payable';
  if (d.status !== 'pending') return 'ok';
  const mode = demoPayMode(ctx);
  if (mode === 'simulate') {
    if (!(ctx.wallet as FakeWallet).simulatePayment(hash)) return 'not_payable';
  } else if (mode === 'test') {
    if (!d.invoice || d.wallet !== ctx.wallet.kind) return 'not_payable';
    if (inFlight.has(hash)) return 'ok';
    inFlight.add(hash);
    try {
      await ctx.testPayer!.payInvoice(d.invoice);
      ctx.log.info('test payment sent', { deposit: d.id, sat: d.amountSat });
    } catch (err) {
      ctx.log.warn('test payment failed', { deposit: d.id, error: errorMessage(err) });
      // another press may have paid it first: the pool wallet has the last word
      const after = await refreshDeposit(ctx, hash).catch(() => undefined);
      return after?.status === 'paid' ? 'ok' : 'failed';
    } finally {
      inFlight.delete(hash);
    }
  } else {
    return 'not_payable';
  }
  await refreshDeposit(ctx, hash);
  return 'ok';
}
