/**
 * Uptime through judging (docs/BRIEF.md §15): a daily SQLite backup kept next to the database,
 * and a dead-man's-switch ping (healthchecks.io style) after the scheduler's jobs.
 * The ping carries counts only, never data about crews.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { errorMessage, type Log } from '../lib/log.js';
import { isoDate, type Clock } from '../lib/time.js';

export interface OpsCtx {
  db: Db;
  /** null: in-memory database, nothing to back up. */
  backupDir: string | null;
  keep: number;
  clock: Clock;
  log: Log;
  /** e.g. https://hc-ping.com/<uuid>; failures go to `<url>/fail`. */
  healthcheckUrl: string | undefined;
  /** Successful pings at most this often (a failure is reported at once). */
  pingEveryMs?: number;
  fetchImpl?: typeof fetch;
}

const NAME = /^ndox-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/** Writes today's backup (UTC) once, with SQLite's online backup; keeps the last `keep`. */
export async function backupIfDue(ctx: OpsCtx): Promise<string | null> {
  if (!ctx.backupDir) return null;
  const file = join(ctx.backupDir, `ndox-${isoDate(ctx.clock())}.sqlite`);
  if (existsSync(file)) return null;
  mkdirSync(ctx.backupDir, { recursive: true });
  const tmp = `${file}.part`;
  try {
    await ctx.db.$client.backup(tmp);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const old = readdirSync(ctx.backupDir)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .slice(ctx.keep);
  for (const f of old) rmSync(join(ctx.backupDir, f), { force: true });
  ctx.log.info('database backed up', { file: file.split('/').pop(), removed: old.length });
  return file;
}

const lastPing = new WeakMap<OpsCtx, number>();

/** Pings the health check: success at most every `pingEveryMs`, failure every time. */
export async function healthPing(
  ctx: OpsCtx,
  ok: boolean,
  summary: Record<string, number | string>,
): Promise<boolean> {
  if (!ctx.healthcheckUrl) return false;
  const now = ctx.clock().getTime();
  const every = ctx.pingEveryMs ?? 5 * 60_000;
  if (ok && now - (lastPing.get(ctx) ?? -Infinity) < every) return false;
  lastPing.set(ctx, now);
  const url = ok ? ctx.healthcheckUrl : `${ctx.healthcheckUrl.replace(/\/$/, '')}/fail`;
  try {
    const res = await (ctx.fetchImpl ?? fetch)(url, {
      method: 'POST',
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    ctx.log.warn('health ping failed', { error: errorMessage(err) });
    return false;
  }
}
