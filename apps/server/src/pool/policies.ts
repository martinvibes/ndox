/**
 * Policies (docs/BRIEF.md §7.1–7.2). A policy is weekly cover for one crew at one site:
 *  - created "pending" with its premium (weeks × weekly premium from the backtest);
 *  - each premium payment activates it after the waiting period (72 h by default), or extends it
 *    without a new waiting period while it still covers;
 *  - it pays for an attestation whose window starts in [activeFrom, activeUntil).
 * Each change is published as a kind 30078 event signed by POOL_SECRET, without personal data.
 */
import { finalizeEvent, type NostrEvent } from '@ndox/oracle';
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { cmToM, type Db } from '../db/index.js';
import { crews, policies, sites } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { dueForRetry } from '../nostr/publisher.js';
import { isoSeconds, unixSeconds } from '../lib/time.js';
import { holderCommitment } from './crews.js';
import type { MoneyCtx } from './deposits.js';

export const KIND_APP_DATA = 30078;
const WEEK_MS = 7 * 24 * 3600_000;

export type PolicyRow = typeof policies.$inferSelect;
export type FundedBy = PolicyRow['fundedBy'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;

export class PolicyError extends Error {
  constructor(
    readonly code: 'unknown_crew' | 'unknown_policy' | 'inactive_crew' | 'cancelled' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface CreatePolicyInput {
  crewId: string;
  fundedBy: FundedBy;
  weeks: number;
  payoutFcfa: number;
  premiumWeeklyFcfa: number;
}

export function createPolicy(db: DbLike, input: CreatePolicyInput): PolicyRow {
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > 52)
    throw new PolicyError('invalid', 'weeks must be an integer from 1 to 52');
  if (!Number.isInteger(input.premiumWeeklyFcfa) || input.premiumWeeklyFcfa < 0)
    throw new PolicyError('invalid', 'premium must be an integer');
  const crew = db.select().from(crews).where(eq(crews.id, input.crewId)).get();
  if (!crew) throw new PolicyError('unknown_crew', 'unknown crew');
  if (!crew.active) throw new PolicyError('inactive_crew', 'crew is not active');
  const site = db.select().from(sites).where(eq(sites.id, crew.site)).get();
  if (!site) throw new PolicyError('invalid', 'unknown site');
  return db
    .insert(policies)
    .values({
      id: `p${randomBytes(6).toString('hex')}`,
      crewId: crew.id,
      site: crew.site,
      payoutFcfa: input.payoutFcfa,
      thresholdCm: site.thresholdCm,
      premiumFcfa: input.premiumWeeklyFcfa * input.weeks,
      weeks: input.weeks,
      fundedBy: input.fundedBy,
      demo: crew.demo,
    })
    .returning()
    .get();
}

/**
 * Records a premium payment of `weeks` of cover made at `paidAt`. Idempotency is the caller's
 * job (deposits flip pending → paid exactly once before calling this).
 */
export function applyPremium(
  db: DbLike,
  policyId: string,
  paidAt: Date,
  waitingHours: number,
  weeks?: number,
): PolicyRow {
  const row = db.select().from(policies).where(eq(policies.id, policyId)).get();
  if (!row) throw new PolicyError('unknown_policy', 'unknown policy');
  if (row.status === 'cancelled') throw new PolicyError('cancelled', 'policy is cancelled');
  const span = (weeks ?? row.weeks) * WEEK_MS;
  const covering =
    row.status === 'active' && row.activeUntil !== null && paidAt < new Date(row.activeUntil);
  const activeFrom = covering
    ? row.activeFrom!
    : isoSeconds(new Date(paidAt.getTime() + waitingHours * 3600_000));
  const activeUntil = covering
    ? isoSeconds(new Date(Date.parse(row.activeUntil!) + span))
    : isoSeconds(new Date(Date.parse(activeFrom) + span));
  return db
    .update(policies)
    .set({
      status: 'active',
      paidAt: isoSeconds(paidAt),
      activeFrom,
      activeUntil,
      eventJson: null,
      publishedAt: null,
      publishResult: null,
    })
    .where(eq(policies.id, policyId))
    .returning()
    .get()!;
}

export function expirePolicies(db: DbLike, now: Date): number {
  return db
    .update(policies)
    .set({ status: 'expired' })
    .where(and(eq(policies.status, 'active'), lte(policies.activeUntil, isoSeconds(now))))
    .run().changes;
}

/**
 * Policies of active crews at `site` whose paid cover includes `at`. The time window decides, not
 * the status: a policy marked expired after `at` (e.g. while the server was down) still covered it.
 */
export function eligiblePolicies(
  db: DbLike,
  site: string,
  at: Date,
  /** true: demo policies only (replays) · false: real ones only (real wallet) · unset: all. */
  opts: { demo?: boolean } = {},
): PolicyRow[] {
  const t = isoSeconds(at);
  return db
    .select({ p: policies })
    .from(policies)
    .innerJoin(crews, eq(crews.id, policies.crewId))
    .where(
      and(
        eq(policies.site, site),
        inArray(policies.status, ['active', 'expired']),
        lte(policies.activeFrom, t),
        gt(policies.activeUntil, t),
        eq(crews.active, true),
        opts.demo === undefined ? undefined : eq(policies.demo, opts.demo),
      ),
    )
    .orderBy(policies.createdAt, policies.id)
    .all()
    .map((r) => r.p);
}

export type PolicyState = 'awaiting_premium' | 'waiting' | 'covered' | 'expired' | 'cancelled';

export function policyStatusAt(p: PolicyRow, at: Date): PolicyState {
  if (p.status === 'cancelled') return 'cancelled';
  if (p.status === 'pending') return 'awaiting_premium';
  if (p.status === 'expired' || !p.activeFrom || !p.activeUntil) return 'expired';
  if (at < new Date(p.activeFrom)) return 'waiting';
  return at < new Date(p.activeUntil) ? 'covered' : 'expired';
}

export function policyEventContent(p: PolicyRow, holderSalt: string) {
  return {
    v: 1,
    policyId: p.id,
    site: p.site,
    payoutFcfa: p.payoutFcfa,
    thresholdM: cmToM(p.thresholdCm),
    activeFrom: p.activeFrom,
    activeUntil: p.activeUntil,
    holderCommitment: holderCommitment(holderSalt, p.crewId),
    fundedBy: p.fundedBy,
    demo: p.demo,
  };
}

function signPolicyEvent(ctx: MoneyCtx, p: PolicyRow, holderSalt: string): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: unixSeconds(ctx.clock()),
      tags: [
        ['d', `ndox:policy:${p.id}`],
        ['t', 'ndox'],
        ['alt', 'Ndox: police de couverture (données anonymisées)'],
      ],
      content: JSON.stringify(policyEventContent(p, holderSalt)),
    },
    ctx.poolSecret,
  );
}

/**
 * Signs the policy events that changed and publishes the unpublished ones (failed publishes are
 * retried after 5 minutes). With NOSTR_PUBLISH=false the events are signed and stored only.
 */
export async function publishPendingPolicies(ctx: MoneyCtx): Promise<number> {
  const unsigned = ctx.db
    .select({ p: policies, salt: crews.holderSalt })
    .from(policies)
    .innerJoin(crews, eq(crews.id, policies.crewId))
    .where(and(eq(policies.status, 'active'), isNull(policies.eventJson)))
    .all();
  for (const { p, salt } of unsigned) {
    const ev = signPolicyEvent(ctx, p, salt);
    ctx.db
      .update(policies)
      .set({ eventJson: JSON.stringify(ev) })
      .where(and(eq(policies.id, p.id), isNull(policies.eventJson)))
      .run();
  }
  if (!ctx.publisher) return 0;

  const now = ctx.clock();
  let published = 0;
  const pending = ctx.db.select().from(policies).where(isNull(policies.publishedAt)).all();
  for (const p of pending) {
    if (!p.eventJson) continue;
    if (!dueForRetry(p.publishResult, now)) continue;
    try {
      const res = await ctx.publisher.publish(JSON.parse(p.eventJson) as NostrEvent);
      ctx.db
        .update(policies)
        .set({
          publishResult: { ...res, at: isoSeconds(now) },
          publishedAt: res.ok ? isoSeconds(now) : null,
        })
        .where(eq(policies.id, p.id))
        .run();
      if (res.ok) published++;
    } catch (err) {
      ctx.log.warn('policy event publish failed', { policyId: p.id, error: errorMessage(err) });
    }
  }
  return published;
}
