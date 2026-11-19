/**
 * Premiums and reserve figures from the committed backtest (data/seed/backtest.json, §12):
 *   weekly premium = (mean danger days per season × payout) ÷ weeks in season × (1 + loading)
 * The mean comes from the backtest at the site's threshold; without an exact entry the nearest
 * lower threshold (more danger days, so a higher premium) is used and reported as the basis.
 */
import { weeklyPremiumFcfa } from '@ndox/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PolicySettings } from './settings.js';

const Backtest = z.object({
  sites: z.array(
    z.object({
      site: z.string(),
      thresholdM: z.number(),
      weeksInSeason: z.number().positive(),
      summary: z.object({ mean: z.number(), worst: z.number().int() }),
      worstWeekDangerDays: z.number().int(),
      sensitivity: z.array(z.object({ thresholdM: z.number(), meanDangerDays: z.number() })),
    }),
  ),
});
type BacktestSite = z.infer<typeof Backtest>['sites'][number];

export interface SiteRisk {
  site: string;
  /** Threshold the mean was computed at (may differ from the requested one). */
  basisThresholdM: number;
  meanDangerDays: number;
  seasonDays: number;
  /** Worst season on record (at the backtest's default threshold). */
  worstSeasonDangerDays: number;
  /** Most danger days in any 7-day window on record (coverage ratio denominator). */
  worstWeekDangerDays: number;
}

export class Pricing {
  private constructor(private readonly sites: Map<string, BacktestSite>) {}

  static load(seedDir: string): Pricing {
    const parsed = Backtest.parse(JSON.parse(readFileSync(join(seedDir, 'backtest.json'), 'utf8')));
    return new Pricing(new Map(parsed.sites.map((s) => [s.site, s])));
  }

  has(site: string): boolean {
    return this.sites.has(site);
  }

  risk(site: string, thresholdM: number): SiteRisk {
    const s = this.sites.get(site);
    if (!s) throw new Error(`no backtest for site ${site}`);
    const eps = 1e-9;
    const sorted = [...s.sensitivity].sort((a, b) => a.thresholdM - b.thresholdM);
    const basis =
      sorted.find((e) => Math.abs(e.thresholdM - thresholdM) < eps) ??
      [...sorted].reverse().find((e) => e.thresholdM < thresholdM) ??
      sorted[0];
    if (!basis) throw new Error(`no sensitivity data for site ${site}`);
    return {
      site,
      basisThresholdM: basis.thresholdM,
      meanDangerDays: basis.meanDangerDays,
      seasonDays: s.weeksInSeason * 7,
      worstSeasonDangerDays: s.summary.worst,
      worstWeekDangerDays: s.worstWeekDangerDays,
    };
  }

  weeklyPremiumFcfa(site: string, thresholdM: number, settings: PolicySettings): number {
    const r = this.risk(site, thresholdM);
    return weeklyPremiumFcfa({
      meanDangerDays: r.meanDangerDays,
      payoutFcfa: settings.payoutFcfa,
      seasonDays: r.seasonDays,
      loading: settings.premiumLoading,
    });
  }
}
