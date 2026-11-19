import cron from 'node-cron';
import { errorMessage, type Log } from '../lib/log.js';
import type { OracleCtx } from '../oracle/jobs.js';
import { runPayoutJobs, type PayoutCtx } from '../payouts/engine.js';
import { tick } from './tick.js';

export interface Scheduler {
  /** Runs a tick now (or joins the one in progress). */
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Every minute (UTC) and once at startup, never overlapping: the oracle's daily loop, then the
 * money jobs (expire policies, check deposits, plan and pay payouts, publish events).
 */
export function startScheduler(s: { live: OracleCtx; money: PayoutCtx }, log: Log): Scheduler {
  let running: Promise<void> | null = null;
  const once = async () => {
    try {
      const r = await tick(s.live);
      for (const a of r.actions)
        log.info(`job ${a.job} ${a.status}`, { site: a.site, date: a.date, detail: a.detail });
    } catch (err) {
      log.error('scheduler tick failed', { error: errorMessage(err) });
    }
    try {
      const m = await runPayoutJobs(s.money);
      const p = m.payouts;
      if (m.planned.length || p.paid || p.failed || p.retry || m.deposits.paid || m.published)
        log.info('money jobs', {
          planned: m.planned.length,
          paid: p.paid,
          retry: p.retry,
          failed: p.failed,
          deposits: m.deposits.paid,
          published: m.published,
        });
    } catch (err) {
      log.error('money jobs failed', { error: errorMessage(err) });
    }
  };
  const runNow = (): Promise<void> => {
    running ??= once().finally(() => {
      running = null;
    });
    return running;
  };
  const task = cron.schedule('* * * * *', () => runNow(), {
    timezone: 'UTC',
    name: 'ndox-tick',
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
