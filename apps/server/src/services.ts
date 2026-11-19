/** Wires configuration, database and adapters into the objects the API, scheduler and CLI use. */
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { deriveKey } from './lib/box.js';
import type { Log } from './lib/log.js';
import { systemClock, type Clock } from './lib/time.js';
import { RelayPublisher, type Publisher } from './nostr/publisher.js';
import type { OracleCtx } from './oracle/jobs.js';
import type { ReplayDeps } from './oracle/replay.js';
import { OutlookService } from './wave/outlook.js';
import { ChainSource, OpenMeteoSource, SeedSource, type ForecastSource } from './wave/source.js';

export interface Services {
  config: Config;
  db: Db;
  log: Log;
  clock: Clock;
  /** null when NOSTR_PUBLISH=false (sign and store, do not publish). */
  publisher: Publisher | null;
  /** Live oracle context (ORACLE_SECRET, `ndox` tag). */
  live: OracleCtx;
  /** Replay dependencies (DEMO_ORACLE_SECRET, seed data first, never published by default). */
  replay: ReplayDeps;
  outlook: OutlookService;
  close(): void;
}

export interface ServiceOverrides {
  clock?: Clock;
  liveSource?: ForecastSource;
  publisher?: Publisher | null;
}

export function createServices(
  config: Config,
  db: Db,
  log: Log,
  o: ServiceOverrides = {},
): Services {
  const clock = o.clock ?? systemClock;
  const http = o.liveSource ?? new OpenMeteoSource();
  const publisher =
    o.publisher !== undefined
      ? o.publisher
      : config.nostrPublish
        ? new RelayPublisher(config.relays)
        : null;
  const live: OracleCtx = {
    db,
    secret: config.secrets.oracle,
    nonceKey: deriveKey(config.secrets.oracle, 'nonce'),
    source: http,
    publisher,
    relays: config.relays,
    clock,
    log,
  };
  const replay: ReplayDeps = {
    db,
    demoSecret: config.secrets.demoOracle,
    source: new ChainSource([new SeedSource(config.seedDir), http]),
    publisher: null,
    relays: config.relays,
    log,
    now: clock,
  };
  return {
    config,
    db,
    log,
    clock,
    publisher,
    live,
    replay,
    outlook: new OutlookService(http, clock),
    close() {
      publisher?.close?.();
      db.$client.close();
    },
  };
}
