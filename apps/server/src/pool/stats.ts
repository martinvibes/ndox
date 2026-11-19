/**
 * Public picture of the pool (GET /api/pool, docs/BRIEF.md §7.4): balance, what is already
 * promised, the coverage ratio, payouts this season and every shortfall on record.
 *
 *   coverage ratio = (balance − reserve floor − outstanding payouts)
 *                    ÷ Σ_site (covered or waiting policies × payout × worst 7-day danger days)
 */
import { fcfaToSat, satToFcfa, seasonBounds, seasonOf, SITES } from '@ndox/shared';
import { and, desc, eq, gt, gte, lte, sql, sum } from 'drizzle-orm';
import { cmToM } from '../db/index.js';
import { deposits, payoutRuns, payouts, policies, sites } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { isoDate, isoSeconds } from '../lib/time.js';
import type { Price } from '../money/price.js';
import { outstandingSatFor, paidTodaySatFor, type PayoutCtx } from '../payouts/engine.js';

export interface SiteCoverage {
  site: string;
  covered: number;
  waiting: number;
  worstWeekDangerDays: number;
  exposureSat: number | null;
  season: { id: string; from: string; to: string; payouts: number; sat: number } | null;
}

export interface PoolSnapshot {
  asOf: string;
  wallet: { kind: 'fake' | 'nwc'; simulated: boolean; network: string };
  /** null if the wallet could not be reached. */
  balanceSat: number | null;
  balanceFcfa: number | null;
  outstandingSat: number;
  reserveFloorSat: number;
  availableSat: number | null;
  dailyCapSat: number;
  paidTodaySat: number;
  payoutFcfa: number;
  price: Omit<Price, 'fetchedAt'> | null;
  coverage: { ratio: number | null; exposureSat: number | null; sites: SiteCoverage[] };
  policies: { covered: number; waiting: number; awaitingPremium: number };
  payouts: { count: number; sat: number; seasonCount: number; seasonSat: number; failed: number };
  /** Sats received, by source. */
  deposits: { premium: number; levy: number; sponsor: number; zap: number };
  shortfalls: {
    attestationId: string;
    site: string;
    date: string;
    dueSat: number;
    planSat: number;
    shortfallSat: number;
    factorPpm: number | null;
    limitedBy: string | null;
  }[];
}

export async function poolSnapshot(ctx: PayoutCtx, network: string): Promise<PoolSnapshot> {
  const { db } = ctx;
  const now = ctx.clock();
  const nowIso = isoSeconds(now);
  const today = isoDate(now);
  const kind = ctx.wallet.kind;
  const s = ctx.settings();

  let balanceSat: number | null = null;
  try {
    balanceSat = await ctx.wallet.getBalanceSat();
  } catch (err) {
    ctx.log.warn('pool balance unavailable', { error: errorMessage(err) });
  }
  let price: Price | null = null;
  try {
    price = await ctx.prices.get();
  } catch (err) {
    ctx.log.warn('price unavailable', { error: errorMessage(err) });
  }

  const outstandingSat = outstandingSatFor(db, kind);
  const availableSat =
    balanceSat === null ? null : Math.max(0, balanceSat - s.reserveFloorSats - outstandingSat);

  // a real wallet never pays demo policies, so they are not part of its exposure
  const demoScope = ctx.wallet.simulated ? undefined : eq(policies.demo, false);
  const live = db
    .select()
    .from(policies)
    .where(and(eq(policies.status, 'active'), gt(policies.activeUntil, nowIso), demoScope))
    .all();
  const thresholds = new Map(
    db
      .select()
      .from(sites)
      .all()
      .map((r) => [r.id, r.thresholdCm]),
  );

  const livePaid = and(
    eq(payouts.replay, false),
    eq(payouts.wallet, kind),
    eq(payouts.status, 'paid'),
  );
  const totals = (where: ReturnType<typeof and>) => {
    const r = db
      .select({ n: sql<number>`count(*)`, s: sum(payouts.amountSat) })
      .from(payouts)
      .where(where)
      .get();
    return { count: Number(r?.n ?? 0), sat: Number(r?.s ?? 0) };
  };

  let exposureSat: number | null = price ? 0 : null;
  let seasonCount = 0;
  let seasonSat = 0;
  const siteRows: SiteCoverage[] = SITES.map((site) => {
    const mine = live.filter((p) => p.site === site.id);
    const covered = mine.filter((p) => p.activeFrom !== null && p.activeFrom <= nowIso).length;
    const thresholdCm = thresholds.get(site.id);
    const wwdd =
      thresholdCm !== undefined && ctx.pricing.has(site.id)
        ? ctx.pricing.risk(site.id, cmToM(thresholdCm)).worstWeekDangerDays
        : 7;
    const siteExposure = price
      ? mine.reduce((t, p) => t + fcfaToSat(p.payoutFcfa, price.xofPerBtc, 'round') * wwdd, 0)
      : null;
    if (exposureSat !== null && siteExposure !== null) exposureSat += siteExposure;

    const seasonId = seasonOf(today, site.seasonMonths);
    let season: SiteCoverage['season'] = null;
    if (seasonId) {
      const [from, to] = seasonBounds(seasonId, site.seasonMonths);
      const t = totals(
        and(
          livePaid,
          eq(payouts.site, site.id),
          gte(payouts.paidAt, `${from}T00:00:00Z`),
          lte(payouts.paidAt, `${to}T23:59:59Z`),
        ),
      );
      season = { id: seasonId, from, to, payouts: t.count, sat: t.sat };
      seasonCount += t.count;
      seasonSat += t.sat;
    }
    return {
      site: site.id,
      covered,
      waiting: mine.length - covered,
      worstWeekDangerDays: wwdd,
      exposureSat: siteExposure,
      season,
    };
  });

  const depositSat = (k: 'premium' | 'levy' | 'sponsor' | 'zap') =>
    Number(
      db
        .select({ s: sum(deposits.amountSat) })
        .from(deposits)
        .where(and(eq(deposits.kind, k), eq(deposits.status, 'paid'), eq(deposits.wallet, kind)))
        .get()?.s ?? 0,
    );
  const all = totals(livePaid);
  const failed = totals(
    and(eq(payouts.replay, false), eq(payouts.wallet, kind), eq(payouts.status, 'failed')),
  ).count;
  const awaitingPremium = db
    .select({ n: sql<number>`count(*)` })
    .from(policies)
    .where(and(eq(policies.status, 'pending'), demoScope))
    .get();

  const shortfalls = db
    .select()
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.replay, false),
        eq(payoutRuns.wallet, kind),
        gt(payoutRuns.shortfallSat, 0),
      ),
    )
    .orderBy(desc(payoutRuns.createdAt))
    .limit(20)
    .all()
    .map((r) => ({
      attestationId: r.attestationId,
      site: r.site,
      date: r.date,
      dueSat: r.dueSat,
      planSat: r.planSat,
      shortfallSat: r.shortfallSat,
      factorPpm: r.factorPpm,
      limitedBy: r.limitedBy,
    }));

  const coveredTotal = siteRows.reduce((t, r) => t + r.covered, 0);
  return {
    asOf: nowIso,
    wallet: { kind, simulated: ctx.wallet.simulated, network },
    balanceSat,
    balanceFcfa: balanceSat !== null && price ? satToFcfa(balanceSat, price.xofPerBtc) : null,
    outstandingSat,
    reserveFloorSat: s.reserveFloorSats,
    availableSat,
    dailyCapSat: s.dailyPayoutCapSats,
    paidTodaySat: paidTodaySatFor(db, kind, now),
    payoutFcfa: s.payoutFcfa,
    price: price
      ? {
          eurPerBtc: price.eurPerBtc,
          xofPerBtc: price.xofPerBtc,
          asOf: price.asOf,
          source: price.source,
          stale: price.stale,
        }
      : null,
    coverage: {
      ratio:
        availableSat !== null && exposureSat
          ? Math.round((availableSat / exposureSat) * 100) / 100
          : null,
      exposureSat,
      sites: siteRows,
    },
    policies: {
      covered: coveredTotal,
      waiting: live.length - coveredTotal,
      awaitingPremium: Number(awaitingPremium?.n ?? 0),
    },
    payouts: { count: all.count, sat: all.sat, seasonCount, seasonSat, failed },
    deposits: {
      premium: depositSat('premium'),
      levy: depositSat('levy'),
      sponsor: depositSat('sponsor'),
      zap: depositSat('zap'),
    },
    shortfalls,
  };
}
