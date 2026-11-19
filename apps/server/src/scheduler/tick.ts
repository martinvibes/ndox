/**
 * One scheduler tick for the live oracle: runs whatever the daily loop says is due now.
 * Runs every minute and on startup, so a server that was down at 20:00 or 05:15 catches up.
 *
 *   >= 20:00 D-1         announce D+1 (tomorrow)
 *   <  05:15 D           announce D if still missing (catch-up; must precede the attestation)
 *   >= 05:00 D, < 18:00  fetch D while a model is missing (failed fetches retried every 5 min)
 *   >= 05:15 D, < 18:00  attest D
 *   always               re-publish events that did not reach enough relays
 */
import { eventIdFor } from '@ndox/oracle';
import { addDays } from '@ndox/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { jobRuns, sites } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { atUtc, isoDate, isoSeconds } from '../lib/time.js';
import {
  announce,
  announcementContent,
  attest,
  fetchForecasts,
  getAnnouncement,
  getAttestation,
  getForecasts,
  JobError,
  publishPending,
  SCHEDULE,
  type OracleCtx,
} from '../oracle/jobs.js';

export const FETCH_RETRY_MS = 5 * 60_000;

export interface TickAction {
  job: 'announce' | 'fetch' | 'attest';
  site: string;
  date: string;
  status: 'ok' | 'error';
  detail: string;
}

export interface TickResult {
  at: string;
  actions: TickAction[];
  republished: number;
}

export function recordJob(
  db: Db,
  row: {
    job: string;
    site?: string | null;
    date?: string | null;
    status: 'ok' | 'skipped' | 'error';
    detail: string;
    startedAt: string;
  },
): void {
  db.insert(jobRuns)
    .values({ ...row, detail: row.detail.slice(0, 500), finishedAt: isoSeconds(new Date()) })
    .run();
}

/** True while a model of the event has no good response and the last failure is old enough to retry. */
export function needsFetch(db: Db, eventId: string, models: readonly string[], now: Date): boolean {
  const rows = getForecasts(db, eventId);
  return models.some((m) => {
    const r = rows.find((x) => x.model === m);
    if (!r) return true;
    if (r.status === 'ok') return false;
    return now.getTime() - Date.parse(r.fetchedAt) >= FETCH_RETRY_MS;
  });
}

export async function tick(ctx: OracleCtx): Promise<TickResult> {
  if (ctx.replayRunId !== undefined) throw new Error('tick drives the live oracle only');
  const now = ctx.clock();
  const today = isoDate(now);
  const tomorrow = addDays(today, 1);
  const actions: TickAction[] = [];

  const run = async (
    job: TickAction['job'],
    site: string,
    date: string,
    fn: () => Promise<string>,
  ) => {
    const startedAt = isoSeconds(new Date());
    try {
      const detail = await fn();
      actions.push({ job, site, date, status: 'ok', detail });
      recordJob(ctx.db, { job, site, date, status: 'ok', detail, startedAt });
    } catch (err) {
      const detail = err instanceof JobError ? `${err.code}: ${err.message}` : errorMessage(err);
      actions.push({ job, site, date, status: 'error', detail });
      recordJob(ctx.db, { job, site, date, status: 'error', detail, startedAt });
      ctx.log.error(`${job} failed`, { site, date, detail });
    }
  };

  const enabled = ctx.db.select().from(sites).where(eq(sites.enabled, true)).all();
  for (const { id: site } of enabled) {
    if (
      now >= atUtc(today, SCHEDULE.announce) &&
      !getAnnouncement(ctx.db, eventIdFor(site, tomorrow))
    ) {
      await run('announce', site, tomorrow, async () => {
        const r = await announce(ctx, site, tomorrow);
        return `nonce ${r.noncePoint.slice(0, 12)}…, published=${r.published}`;
      });
    }
    if (now < atUtc(today, SCHEDULE.attest) && !getAnnouncement(ctx.db, eventIdFor(site, today))) {
      await run('announce', site, today, async () => {
        const r = await announce(ctx, site, today);
        return `catch-up, nonce ${r.noncePoint.slice(0, 12)}…, published=${r.published}`;
      });
    }

    const eventId = eventIdFor(site, today);
    const ann = getAnnouncement(ctx.db, eventId);
    if (!ann || getAttestation(ctx.db, eventId)) continue;
    const { content } = announcementContent(ann);
    if (now >= new Date(content.window.end)) continue; // missed: the nonce is never used

    if (
      now >= atUtc(today, SCHEDULE.fetch) &&
      needsFetch(ctx.db, eventId, content.rule.models, now)
    ) {
      await run('fetch', site, today, async () => {
        const r = await fetchForecasts(ctx, site, today);
        return r.models
          .map(
            (m) => `${m.model}=${m.ok ? `${m.windowMaxM ?? 'null'}m/${m.validHours}h` : 'error'}`,
          )
          .join(' ');
      });
    }
    if (now >= new Date(content.attestAt)) {
      await run('attest', site, today, async () => {
        const r = await attest(ctx, site, today);
        return `${r.outcome} (${r.decisiveM ?? 'n/a'} m), published=${r.published}`;
      });
    }
  }

  const republished = await publishPending(ctx);
  return { at: isoSeconds(now), actions, republished };
}
