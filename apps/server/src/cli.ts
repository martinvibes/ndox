/**
 * ndox command line (same code paths as the scheduler and the API).
 *
 *   pnpm ndox tick
 *   pnpm ndox announce [--site S] [--date D] [--dry-run]
 *   pnpm ndox replay --site kayar --date 2026-02-27
 *   (in Docker: docker compose exec ndox node dist/cli.js <command> …)
 */
import { verifyAttestationEvent, type NostrEvent } from '@ndox/oracle';
import { addDays, isSiteId, SITE_IDS } from '@ndox/shared';
import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { sites } from './db/schema.js';
import { consoleLog, errorMessage } from './lib/log.js';
import { isoDate, isValidDate } from './lib/time.js';
import { RelayPublisher } from './nostr/publisher.js';
import {
  announce,
  attest,
  fetchForecasts,
  getAnnouncement,
  getAttestation,
  JobError,
  type OracleCtx,
} from './oracle/jobs.js';
import { runReplay } from './oracle/replay.js';
import { runPayoutJobs } from './payouts/engine.js';
import { payReplay } from './payouts/replay.js';
import { tick } from './scheduler/tick.js';
import { createServices } from './services.js';

const USAGE = `Usage: ndox <command> [options]

Live oracle (ORACLE_SECRET):
  tick                                   run whatever the daily loop says is due now
  announce [--site S] [--date D]         commit tomorrow's nonce (default date: tomorrow)
  fetch    [--site S] [--date D]         store both models' raw forecasts (default: today)
  attest   [--site S] [--date D]         sign today's outcome (default: today)
           --dry-run                     sign and store, but do not publish to relays
Money (POOL_SECRET, WALLET_MODE):
  payouts                                plan, pay and publish now (what the scheduler does each minute)
Demo:
  replay --site S --date D [--publish]   replay a past day with the demo key (tag ndox-replay);
         [--no-pay]                      a danger day pays the demo crews from a simulated wallet
Tools:
  verify --event EVENT_ID                re-run the public verifier on stored events
  migrate                                apply database migrations and exit

Sites: ${SITE_IDS.join(', ')}. Dates: YYYY-MM-DD (UTC). Publishing to relays needs NOSTR_PUBLISH=true.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string' },
    date: { type: 'string' },
    event: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    'no-pay': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
if (!command || values.help) {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 1);
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.databasePath, {
  migrationsDir: config.migrationsDir,
  defaultThresholdM: config.defaultThresholdM,
});
const services = createServices(config, db, consoleLog);

function sitesArg(): string[] {
  if (values.site) {
    if (!isSiteId(values.site)) fail(`unknown site "${values.site}" (${SITE_IDS.join(', ')})`);
    return [values.site];
  }
  return db
    .select()
    .from(sites)
    .where(eq(sites.enabled, true))
    .all()
    .map((s) => s.id);
}

function dateArg(fallback: string): string {
  const d = values.date ?? fallback;
  if (!isValidDate(d)) fail(`invalid date "${d}" (YYYY-MM-DD)`);
  return d;
}

function liveCtx(): OracleCtx {
  if (values['dry-run'] || !services.publisher) {
    if (!values['dry-run'])
      console.log('note: NOSTR_PUBLISH=false — signing without publishing (dry run)');
    return { ...services.live, publisher: null };
  }
  return services.live;
}

const today = isoDate(new Date());

try {
  switch (command) {
    case 'migrate':
      console.log(`database ready: ${config.databasePath}`);
      break;

    case 'tick': {
      const r = await tick(liveCtx());
      if (r.actions.length === 0) console.log('nothing due');
      for (const a of r.actions)
        console.log(`${a.job.padEnd(8)} ${a.site.padEnd(13)} ${a.date}  ${a.status}  ${a.detail}`);
      if (r.republished) console.log(`re-published ${r.republished} event(s)`);
      break;
    }

    case 'announce':
    case 'fetch':
    case 'attest': {
      const ctx = liveCtx();
      const date = dateArg(command === 'announce' ? addDays(today, 1) : today);
      for (const site of sitesArg()) {
        try {
          if (command === 'announce') {
            const r = await announce(ctx, site, date);
            console.log(
              `${r.eventId}  ${r.created ? 'created' : 'exists'}  R=${r.noncePoint}  published=${r.published}`,
            );
          } else if (command === 'fetch') {
            const r = await fetchForecasts(ctx, site, date);
            const models = r.models.map(
              (m) =>
                `${m.model}=${m.ok ? `${m.windowMaxM ?? 'null'} m/${m.validHours} h` : `error (${m.error})`}`,
            );
            console.log(
              `${r.eventId}  ${r.status}${r.reason ? ` (${r.reason})` : ''}  ${models.join('  ')}`,
            );
          } else {
            const r = await attest(ctx, site, date);
            console.log(
              `${r.eventId}  ${r.created ? 'signed' : 'exists'}  ${r.outcome}  decisive=${r.decisiveM ?? 'n/a'} m  published=${r.published}`,
            );
          }
        } catch (err) {
          process.exitCode = 1;
          console.error(
            `${site} ${date}: ${err instanceof JobError ? `${err.code}: ` : ''}${errorMessage(err)}`,
          );
        }
      }
      break;
    }

    case 'replay': {
      if (!values.site || !values.date) fail('replay needs --site and --date');
      if (!isSiteId(values.site)) fail(`unknown site "${values.site}"`);
      const deps = { ...services.replay };
      if (values.publish) deps.publisher = new RelayPublisher(config.relays);
      const r = await runReplay(deps, values.site, dateArg(values.date));
      console.log(
        `Rejeu ${r.runId} — ${r.site} ${r.date} (demo oracle key, tag ndox-replay${values.publish ? ', published' : ', not published'})`,
      );
      for (const s of r.steps)
        console.log(`  ${s.at}  ${s.step.padEnd(8)} ${JSON.stringify(s.detail)}`);
      console.log(`  outcome: ${r.outcome}  decisive: ${r.decisiveM ?? 'n/a'} m`);
      for (const c of r.verification.checks)
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
      console.log(`  event: ${r.eventId}`);
      if (!r.verification.ok) process.exitCode = 1;
      if (r.outcome === 'danger' && r.verification.ok && !values['no-pay']) {
        const p = await payReplay(services.money, r, services.replayPayouts);
        console.log(
          `  payouts (Simulé, ${p.at}): ${p.paid}/${p.policies} demo crew(s) paid, ${p.paidSat} sats` +
            (p.shortfallSat ? `, shortfall ${p.shortfallSat} sats` : ''),
        );
        for (const x of p.payouts)
          console.log(
            `    ${x.pseudonym.padEnd(16)} ${String(x.amountSat).padStart(7)} sats  ${x.status}`,
          );
      }
      deps.publisher?.close?.();
      break;
    }

    case 'payouts': {
      const ctx = services.publisher ? services.money : { ...services.money, publisher: null };
      const r = await runPayoutJobs(ctx);
      const p = r.payouts;
      console.log(
        `wallet: ${services.wallet.kind}${services.wallet.simulated ? ' (Simulé)' : ''}  ` +
          `balance: ${await services.wallet.getBalanceSat()} sats`,
      );
      console.log(`policies expired: ${r.expiredPolicies}`);
      console.log(
        `deposits checked ${r.deposits.checked}, paid ${r.deposits.paid}, expired ${r.deposits.expired}`,
      );
      console.log(`runs planned: ${r.planned.length ? r.planned.join(', ') : 'none'}`);
      console.log(
        `payouts: ${p.processed} due — paid ${p.paid}, retry ${p.retry}, waiting ${p.waiting}, failed ${p.failed}, errors ${p.errors}`,
      );
      console.log(`events published: ${r.published}`);
      if (p.failed || p.errors) process.exitCode = 1;
      break;
    }

    case 'verify': {
      const eventId = values.event ?? fail('verify needs --event');
      const ann = getAnnouncement(db, eventId);
      const att = getAttestation(db, eventId);
      if (!ann || !att) fail(`no announcement + attestation stored for ${eventId}`);
      const report = verifyAttestationEvent(
        JSON.parse(ann.eventJson) as NostrEvent,
        JSON.parse(att.eventJson) as NostrEvent,
      );
      for (const c of report.checks)
        console.log(`${c.ok ? '✓' : '✗'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
      console.log(report.ok ? `valid: ${report.outcome}` : `INVALID: ${report.error ?? ''}`);
      if (!report.ok) process.exitCode = 1;
      break;
    }

    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${err instanceof JobError ? `${err.code}: ` : ''}${errorMessage(err)}`);
  process.exitCode = 1;
} finally {
  services.close();
}
