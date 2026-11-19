/**
 * 7-day danger outlook (not attested): today's forecasts from both live models, the same
 * 06–18 UTC daily max and the same rule as the oracle. Cached per site for 30 minutes.
 */
import type { RuleSpec } from '@ndox/oracle';
import {
  addDays,
  dailyAt,
  dailyWindowMaxima,
  decideOutcome,
  parseMarineResponse,
  seriesFromResponse,
  type Outcome,
  type SiteConfig,
} from '@ndox/shared';
import { isoDate, isoSeconds, type Clock } from '../lib/time.js';
import type { ForecastSource } from './source.js';

export const OUTLOOK_DAYS = 7;

export interface OutlookDay {
  date: string;
  outcome: Outcome;
  decisiveM: number | null;
  models: { id: string; windowMaxM: number | null; validHours: number }[];
}

export interface Outlook {
  site: string;
  generatedAt: string;
  attested: false;
  thresholdM: number;
  sources: { model: string; url: string; fetchedAt: string; sha256: string }[];
  days: OutlookDay[];
}

export class OutlookService {
  private readonly cache = new Map<string, { expires: number; value: Promise<Outlook> }>();

  constructor(
    private readonly source: ForecastSource,
    private readonly clock: Clock,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  get(site: SiteConfig, rule: RuleSpec): Promise<Outlook> {
    const now = this.clock();
    const key = `${site.id}:${isoDate(now)}:${rule.thresholdM}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > now.getTime()) return hit.value;
    const value = this.compute(site, rule, now);
    this.cache.set(key, { expires: now.getTime() + this.ttlMs, value });
    value.catch(() => this.cache.delete(key)); // never cache failures
    return value;
  }

  private async compute(site: SiteConfig, rule: RuleSpec, now: Date): Promise<Outlook> {
    const today = isoDate(now);
    const end = addDays(today, OUTLOOK_DAYS - 1);
    const perModel = await Promise.all(
      rule.models.map(async (model) => {
        const env = await this.source.get({ site, model, startDate: today, endDate: end });
        const s = seriesFromResponse(parseMarineResponse(env.body), rule.variable);
        return { model, env, daily: dailyWindowMaxima(s.time, s.values) };
      }),
    );
    const days: OutlookDay[] = [];
    for (let i = 0; i < OUTLOOK_DAYS; i++) {
      const date = addDays(today, i);
      const models = perModel.map((p) => {
        const d = dailyAt(p.daily, date);
        return { id: p.model, windowMaxM: d?.maxM ?? null, validHours: d?.validHours ?? 0 };
      });
      const outcome = decideOutcome(rule, models);
      const maxima = models.map((m) => m.windowMaxM);
      const decisiveM = maxima.every((m): m is number => m !== null) ? Math.min(...maxima) : null;
      days.push({ date, outcome, decisiveM, models });
    }
    return {
      site: site.id,
      generatedAt: isoSeconds(now),
      attested: false,
      thresholdM: rule.thresholdM,
      sources: perModel.map((p) => ({
        model: p.model,
        url: p.env.url,
        fetchedAt: p.env.fetchedAt,
        sha256: p.env.sha256,
      })),
      days,
    };
  }
}
