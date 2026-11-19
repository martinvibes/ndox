import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { fromPino } from './lib/log.js';
import { createLogger } from './logger.js';
import { startScheduler, type Scheduler } from './scheduler/index.js';
import { createServices } from './services.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const log = fromPino(logger);
if (config.generatedSecretsFile) {
  log.warn('using generated secrets (WALLET_MODE=fake)', { file: config.generatedSecretsFile });
}

const db = openDb(config.databasePath, {
  migrationsDir: config.migrationsDir,
  defaultThresholdM: config.defaultThresholdM,
});
const services = createServices(config, db, log);
const app = await buildApp({ webDir: config.webDir, logger, services });

let scheduler: Scheduler | undefined;
if (config.scheduler) scheduler = startScheduler(services.live, log);
log.info('ndox starting', {
  walletMode: config.walletMode,
  network: config.network,
  nostrPublish: config.nostrPublish,
  scheduler: config.scheduler,
});

await app.listen({ port: config.port, host: '0.0.0.0' });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info('shutting down', { signal });
  await scheduler?.stop();
  await app.close();
  services.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
