/**
 * Dashboard alerts (docs/BRIEF.md §7.3, §14): derived on demand from what is stored, so nothing
 * can drift. Never contains personal data: crews appear by pseudonym, errors are already scrubbed.
 */
import { and, count, desc, eq, gte, isNull, lt, max } from 'drizzle-orm';
import { attestations, crews, jobRuns, payoutRuns, payouts, policies } from '../db/schema.js';
import { isoSeconds } from '../lib/time.js';
import type { PoolSnapshot } from '../pool/stats.js';
import type { Services } from '../services.js';

export interface Alert {
  level: 'error' | 'warning';
  code:
    | 'wallet_unreachable'
    | 'price_unavailable'
    | 'price_stale'
    | 'payout_failed'
    | 'attestation_invalid'
    | 'shortfall'
    | 'low_coverage'
    | 'data_unavailable'
    | 'job_error'
    | 'publish_backlog';
  /** Most recent occurrence. */
  at: string;
  count: number;
  detail: Record<string, string | number | null>;
}

const DAY = 24 * 3600_000;

export function collectAlerts(s: Services, pool: PoolSnapshot): Alert[] {
  const { db } = s;
  const now = s.clock();
  const nowIso = isoSeconds(now);
  const since = (ms: number) => isoSeconds(new Date(now.getTime() - ms));
  const kind = s.wallet.kind;
  const out: Alert[] = [];

  if (pool.balanceSat === null)
    out.push({ level: 'error', code: 'wallet_unreachable', at: nowIso, count: 1, detail: {} });
  if (!pool.price)
    out.push({ level: 'error', code: 'price_unavailable', at: nowIso, count: 1, detail: {} });
  else if (pool.price.stale)
    out.push({
      level: 'warning',
      code: 'price_stale',
      at: pool.price.asOf,
      count: 1,
      detail: { source: pool.price.source },
    });
  if (pool.coverage.ratio !== null && pool.coverage.ratio < 1)
    out.push({
      level: 'warning',
      code: 'low_coverage',
      at: nowIso,
      count: 1,
      detail: { ratio: pool.coverage.ratio, exposureSat: pool.coverage.exposureSat },
    });

  const failed = db
    .select({ p: payouts, pseudonym: crews.pseudonym })
    .from(payouts)
    .innerJoin(policies, eq(policies.id, payouts.policyId))
    .innerJoin(crews, eq(crews.id, policies.crewId))
    .where(and(eq(payouts.replay, false), eq(payouts.wallet, kind), eq(payouts.status, 'failed')))
    .orderBy(desc(payouts.updatedAt))
    .all();
  for (const { p, pseudonym } of failed.slice(0, 20))
    out.push({
      level: 'error',
      code: 'payout_failed',
      at: p.updatedAt,
      count: 1,
      detail: {
        payoutId: p.id,
        crew: pseudonym,
        site: p.site,
        amountSat: p.amountSat,
        attempts: p.attempts,
        error: p.error,
      },
    });

  for (const r of db
    .select()
    .from(payoutRuns)
    .where(and(eq(payoutRuns.replay, false), eq(payoutRuns.status, 'invalid')))
    .orderBy(desc(payoutRuns.createdAt))
    .limit(10)
    .all())
    out.push({
      level: 'error',
      code: 'attestation_invalid',
      at: r.createdAt,
      count: 1,
      detail: { attestationId: r.attestationId, site: r.site, date: r.date, reason: r.detail },
    });

  for (const r of db
    .select()
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.replay, false),
        eq(payoutRuns.wallet, kind),
        gte(payoutRuns.createdAt, since(7 * DAY)),
      ),
    )
    .orderBy(desc(payoutRuns.createdAt))
    .all()
    .filter((r) => r.shortfallSat > 0))
    out.push({
      level: 'warning',
      code: 'shortfall',
      at: r.createdAt,
      count: 1,
      detail: {
        site: r.site,
        date: r.date,
        dueSat: r.dueSat,
        planSat: r.planSat,
        shortfallSat: r.shortfallSat,
        limitedBy: r.limitedBy,
      },
    });

  for (const a of db
    .select()
    .from(attestations)
    .where(
      and(
        isNull(attestations.replayRunId),
        eq(attestations.outcome, 'indisponible'),
        gte(attestations.createdAt, since(7 * DAY)),
      ),
    )
    .orderBy(desc(attestations.createdAt))
    .all())
    out.push({
      level: 'warning',
      code: 'data_unavailable',
      at: a.createdAt,
      count: 1,
      detail: { site: a.site, date: a.date },
    });

  for (const j of db
    .select({ job: jobRuns.job, site: jobRuns.site, n: count(), at: max(jobRuns.finishedAt) })
    .from(jobRuns)
    .where(and(eq(jobRuns.status, 'error'), gte(jobRuns.startedAt, since(DAY))))
    .groupBy(jobRuns.job, jobRuns.site)
    .all()) {
    const last = db
      .select({ detail: jobRuns.detail })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.job, j.job),
          j.site === null ? isNull(jobRuns.site) : eq(jobRuns.site, j.site),
          eq(jobRuns.status, 'error'),
        ),
      )
      .orderBy(desc(jobRuns.startedAt))
      .get();
    out.push({
      level: 'warning',
      code: 'job_error',
      at: j.at ?? nowIso,
      count: j.n,
      detail: { job: j.job, site: j.site, error: last?.detail ?? null },
    });
  }

  if (s.publisher) {
    const backlog = db
      .select({ n: count(), at: max(attestations.createdAt) })
      .from(attestations)
      .where(
        and(
          isNull(attestations.replayRunId),
          isNull(attestations.publishedAt),
          lt(attestations.createdAt, since(3600_000)),
        ),
      )
      .get();
    if (backlog && backlog.n > 0)
      out.push({
        level: 'warning',
        code: 'publish_backlog',
        at: backlog.at ?? nowIso,
        count: backlog.n,
        detail: {},
      });
  }

  const rank = (a: Alert) => (a.level === 'error' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}
