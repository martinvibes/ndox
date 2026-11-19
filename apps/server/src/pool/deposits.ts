/**
 * Money in (docs/BRIEF.md §7.4): crew premiums, CLPA levy deposits and sponsor top-ups, each a
 * Lightning invoice from the pool wallet. A deposit flips pending → paid exactly once (conditional
 * update), and only then does it activate cover. Zaps are recorded by nostr/zaps.ts.
 */
import { fcfaToSat, getSite } from '@ndox/shared';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { cmToM, type Db } from '../db/index.js';
import { crews, deposits, policies, sites } from '../db/schema.js';
import { errorMessage, type Log } from '../lib/log.js';
import { isoSeconds, type Clock } from '../lib/time.js';
import type { PriceService } from '../money/price.js';
import type { Publisher } from '../nostr/publisher.js';
import { DEFAULT_INVOICE_EXPIRY_SEC, type Wallet } from '../wallet/types.js';
import { applyPremium, createPolicy, publishPendingPolicies, type DbLike } from './policies.js';
import type { Pricing } from './pricing.js';
import type { PolicySettings } from './settings.js';

export interface MoneyCtx {
  db: Db;
  wallet: Wallet;
  prices: PriceService;
  clock: Clock;
  poolSecret: string;
  /** null = sign and store only (NOSTR_PUBLISH=false). */
  publisher: Publisher | null;
  relays: string[];
  pricing: Pricing;
  settings: () => PolicySettings;
  log: Log;
}

export type DepositRow = typeof deposits.$inferSelect;

export class DepositError extends Error {
  constructor(
    readonly code: 'unknown_crew' | 'unknown_policy' | 'invalid_amount' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DepositError';
  }
}

export const MEMO = {
  premium: 'Ndox · prime de couverture',
  levy: 'Versement caisse CLPA',
  sponsor: 'Ndox · soutien à la caisse',
} as const;

export interface CreateDepositInput {
  kind: 'premium' | 'levy' | 'sponsor';
  amountFcfa?: number;
  policyId?: string;
  /** Sponsor: gift weeks of cover to this crew. */
  crewPseudonym?: string;
  /** Sponsor: landing site the gift is meant for (recorded only; there is one pool). */
  site?: string;
}

const MIN_FCFA = 100;
const MAX_FCFA = 5_000_000;

export async function createDeposit(ctx: MoneyCtx, input: CreateDepositInput): Promise<DepositRow> {
  let amountFcfa: number;
  let policyId: string | null = null;
  let crewId: string | null = null;
  let site: string | null = null;

  if (input.kind === 'premium') {
    const p = input.policyId
      ? ctx.db.select().from(policies).where(eq(policies.id, input.policyId)).get()
      : undefined;
    if (!p || p.status === 'cancelled') throw new DepositError('unknown_policy', 'unknown policy');
    amountFcfa = p.premiumFcfa;
    policyId = p.id;
    crewId = p.crewId;
    site = p.site;
  } else {
    amountFcfa = input.amountFcfa ?? 0;
    if (!Number.isInteger(amountFcfa) || amountFcfa < MIN_FCFA || amountFcfa > MAX_FCFA)
      throw new DepositError('invalid_amount', `amount must be ${MIN_FCFA}–${MAX_FCFA} FCFA`);
    if (input.kind === 'sponsor' && input.crewPseudonym) {
      const crew = ctx.db
        .select()
        .from(crews)
        .where(and(eq(crews.pseudonym, input.crewPseudonym), eq(crews.active, true)))
        .get();
      if (!crew) throw new DepositError('unknown_crew', 'unknown crew');
      crewId = crew.id;
      site = crew.site;
    } else if (input.site !== undefined) {
      if (!getSite(input.site)) throw new DepositError('invalid', 'unknown site');
      site = input.site;
    }
  }

  const price = await ctx.prices.get();
  const amountSat = fcfaToSat(amountFcfa, price.xofPerBtc, 'ceil');
  const memo = MEMO[input.kind];
  const inv = await ctx.wallet.makeInvoice(amountSat, memo, DEFAULT_INVOICE_EXPIRY_SEC);
  return ctx.db
    .insert(deposits)
    .values({
      id: `d${randomBytes(6).toString('hex')}`,
      kind: input.kind,
      status: 'pending',
      amountSat,
      amountFcfa,
      xofPerBtc: price.xofPerBtc,
      paymentHash: inv.paymentHash,
      invoice: inv.invoice,
      policyId,
      crewId,
      site,
      memo,
      wallet: ctx.wallet.kind,
      demo: ctx.wallet.simulated,
      createdAt: isoSeconds(ctx.clock()),
      expiresAt: inv.expiresAt,
    })
    .returning()
    .get();
}

/** Weekly premium (FCFA) at a site's current threshold, from the backtest. */
export function weeklyPremiumFor(ctx: MoneyCtx, db: DbLike, site: string): number {
  const s = db.select().from(sites).where(eq(sites.id, site)).get();
  if (!s) throw new DepositError('invalid', 'unknown site');
  return ctx.pricing.weeklyPremiumFcfa(site, cmToM(s.thresholdCm), ctx.settings());
}

/** pending → paid, once; then the deposit's effect on cover. Returns false if already settled. */
function settle(ctx: MoneyCtx, d: DepositRow, paidAt: Date): boolean {
  const settings = ctx.settings();
  return ctx.db.transaction((tx) => {
    const res = tx
      .update(deposits)
      .set({ status: 'paid', paidAt: isoSeconds(paidAt) })
      .where(and(eq(deposits.id, d.id), eq(deposits.status, 'pending')))
      .run();
    if (res.changes !== 1) return false;

    if (d.kind === 'premium' && d.policyId) {
      applyPremium(tx, d.policyId, paidAt, settings.waitingHours);
    } else if (d.kind === 'sponsor' && d.crewId && d.site && d.amountFcfa) {
      const weekly = weeklyPremiumFor(ctx, tx, d.site);
      const weeks = weekly > 0 ? Math.min(52, Math.floor(d.amountFcfa / weekly)) : 0;
      if (weeks >= 1) {
        const current = tx
          .select()
          .from(policies)
          .where(and(eq(policies.crewId, d.crewId), eq(policies.status, 'active')))
          .all()
          .find((p) => p.activeUntil !== null && paidAt < new Date(p.activeUntil));
        const policy =
          current ??
          createPolicy(tx, {
            crewId: d.crewId,
            fundedBy: 'sponsor',
            weeks,
            payoutFcfa: settings.payoutFcfa,
            premiumWeeklyFcfa: weekly,
          });
        tx.update(deposits).set({ policyId: policy.id }).where(eq(deposits.id, d.id)).run();
        applyPremium(tx, policy.id, paidAt, settings.waitingHours, weeks);
      }
      // less than a week of premium: the gift stays in the pool as general funds
    }
    return true;
  });
}

/** Checks one deposit with the wallet; settles or expires it. */
export async function refreshDeposit(
  ctx: MoneyCtx,
  paymentHash: string,
): Promise<DepositRow | undefined> {
  const d = ctx.db.select().from(deposits).where(eq(deposits.paymentHash, paymentHash)).get();
  if (!d || d.status !== 'pending') return d;
  const look = await ctx.wallet.lookupInvoice(paymentHash);
  const now = ctx.clock();
  // an invoice we issued can only be paid to us; a wallet saying otherwise is not trusted
  if (look.state === 'settled' && look.direction !== 'outgoing') {
    if (settle(ctx, d, now)) {
      ctx.log.info('deposit paid', { deposit: d.id, kind: d.kind, sat: d.amountSat });
      await publishPendingPolicies(ctx).catch((err: unknown) =>
        ctx.log.warn('policy publish failed', { error: errorMessage(err) }),
      );
    }
  } else if (
    look.state === 'failed' ||
    (look.state === 'not_found' && d.expiresAt && now >= new Date(d.expiresAt))
  ) {
    ctx.db
      .update(deposits)
      .set({ status: 'expired' })
      .where(and(eq(deposits.id, d.id), eq(deposits.status, 'pending')))
      .run();
  }
  return ctx.db.select().from(deposits).where(eq(deposits.id, d.id)).get();
}

/** Checks every pending deposit (scheduler, once a minute). */
export async function pollDeposits(
  ctx: MoneyCtx,
): Promise<{ checked: number; paid: number; expired: number }> {
  const pending = ctx.db.select().from(deposits).where(eq(deposits.status, 'pending')).all();
  let paid = 0;
  let expired = 0;
  for (const d of pending) {
    if (!d.paymentHash) continue;
    try {
      const r = await refreshDeposit(ctx, d.paymentHash);
      if (r?.status === 'paid') paid++;
      if (r?.status === 'expired') expired++;
    } catch (err) {
      ctx.log.warn('deposit check failed', { deposit: d.id, error: errorMessage(err) });
    }
  }
  return { checked: pending.length, paid, expired };
}
