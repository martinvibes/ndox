/**
 * Demo replay of a past day (docs/BRIEF.md §6.3, §18): the same jobs as the live oracle, run on a
 * simulated clock (announce D-1 20:00 → fetch D 05:00 → attest D 05:15), signed by the separate
 * DEMO oracle key, with event ids `ndox-replay:<site>:<date>:<runId>` and the `ndox-replay` tag.
 * Forecasts come from the committed seed (raw Open-Meteo responses with their hashes), falling
 * back to Open-Meteo's archive. Not published to relays unless explicitly asked.
 */
import {
  getPublicKey,
  verifyAttestationEvent,
  type NostrEvent,
  type VerificationReport,
} from '@ndox/oracle';
import { addDays, getSite } from '@ndox/shared';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { replayRuns } from '../db/schema.js';
import { deriveKey } from '../lib/box.js';
import { errorMessage, type Log } from '../lib/log.js';
import { atUtc, isoDate, isoSeconds, isValidDate } from '../lib/time.js';
import type { Publisher } from '../nostr/publisher.js';
import type { ForecastSource } from '../wave/source.js';
import {
  announce,
  attest,
  fetchForecasts,
  getAnnouncement,
  getAttestation,
  JobError,
  SCHEDULE,
  type OracleCtx,
} from './jobs.js';

export interface ReplayDeps {
  db: Db;
  demoSecret: string;
  source: ForecastSource;
  /** null = do not publish (default for replays). */
  publisher: Publisher | null;
  relays: string[];
  log: Log;
  /** Real clock, used to refuse replays of today or the future. */
  now?: () => Date;
}

export interface ReplayStep {
  step: 'announce' | 'fetch' | 'attest';
  /** Simulated time of the step (labelled "Rejeu" in the UI). */
  at: string;
  detail: Record<string, unknown>;
}

export interface ReplayResult {
  runId: string;
  eventId: string;
  site: string;
  date: string;
  outcome: string;
  decisiveM: number | null;
  steps: ReplayStep[];
  verification: VerificationReport;
}

export function newReplayRunId(): string {
  return `r${randomBytes(4).toString('hex')}`;
}

export async function runReplay(
  deps: ReplayDeps,
  site: string,
  date: string,
): Promise<ReplayResult> {
  if (!getSite(site)) throw new JobError('unknown_site', `unknown site ${site}`);
  if (!isValidDate(date)) throw new JobError('invalid_date', `invalid date ${date}`);
  const today = isoDate((deps.now ?? (() => new Date()))());
  if (date >= today) throw new JobError('not_past', 'only past days can be replayed');

  const runId = newReplayRunId();
  deps.db.insert(replayRuns).values({ id: runId, site, date, status: 'running' }).run();
  let simulated = atUtc(addDays(date, -1), SCHEDULE.announce);
  const ctx: OracleCtx = {
    db: deps.db,
    secret: deps.demoSecret,
    nonceKey: deriveKey(deps.demoSecret, 'nonce'),
    source: deps.source,
    publisher: deps.publisher,
    relays: deps.relays,
    clock: () => simulated,
    replayRunId: runId,
    log: deps.log,
  };
  const steps: ReplayStep[] = [];
  try {
    const a = await announce(ctx, site, date);
    steps.push({
      step: 'announce',
      at: isoSeconds(simulated),
      detail: { nostrId: a.nostrId, noncePoint: a.noncePoint },
    });

    simulated = atUtc(date, SCHEDULE.fetch);
    const f = await fetchForecasts(ctx, site, date);
    steps.push({
      step: 'fetch',
      at: isoSeconds(simulated),
      detail: { source: deps.source.name, models: f.models },
    });

    simulated = atUtc(date, SCHEDULE.attest);
    const t = await attest(ctx, site, date);
    steps.push({
      step: 'attest',
      at: isoSeconds(simulated),
      detail: { nostrId: t.nostrId, outcome: t.outcome, decisiveM: t.decisiveM },
    });

    const annEvent = JSON.parse(
      getAnnouncement(deps.db, t.eventId)?.eventJson ?? 'null',
    ) as NostrEvent;
    const attEvent = JSON.parse(
      getAttestation(deps.db, t.eventId)?.eventJson ?? 'null',
    ) as NostrEvent;
    const verification = verifyAttestationEvent(annEvent, attEvent, {
      expectedOraclePubkey: getPublicKey(deps.demoSecret),
    });
    const result: ReplayResult = {
      runId,
      eventId: t.eventId,
      site,
      date,
      outcome: t.outcome,
      decisiveM: t.decisiveM,
      steps,
      verification,
    };
    deps.db
      .update(replayRuns)
      .set({ status: 'done', detail: { eventId: t.eventId, outcome: t.outcome, steps } })
      .where(eq(replayRuns.id, runId))
      .run();
    return result;
  } catch (err) {
    deps.db
      .update(replayRuns)
      .set({ status: 'failed', detail: { error: errorMessage(err), steps } })
      .where(eq(replayRuns.id, runId))
      .run();
    throw err;
  }
}
