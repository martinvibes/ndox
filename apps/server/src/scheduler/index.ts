import cron from 'node-cron';
import { errorMessage, type Log } from '../lib/log.js';
import type { OracleCtx } from '../oracle/jobs.js';
import { tick } from './tick.js';

export interface Scheduler {
  /** Runs a tick now (or joins the one in progress). */
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

/** Ticks every minute (UTC) and once at startup; ticks never overlap. */
export function startScheduler(ctx: OracleCtx, log: Log): Scheduler {
  let running: Promise<void> | null = null;
  const runNow = (): Promise<void> => {
    running ??= tick(ctx)
      .then((r) => {
        for (const a of r.actions)
          log.info(`job ${a.job} ${a.status}`, { site: a.site, date: a.date, detail: a.detail });
      })
      .catch((err: unknown) => log.error('scheduler tick failed', { error: errorMessage(err) }))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const task = cron.schedule('* * * * *', () => runNow(), {
    timezone: 'UTC',
    name: 'ndox-oracle-tick',
  });
  void runNow();
  log.info('scheduler started', { every: '1 min (UTC)' });
  return {
    runNow,
    async stop() {
      await task.stop();
      await running;
    },
  };
}
