/**
 * Starts a throwaway Ndox for the Playwright smoke test: fake wallet, fresh database, demo crews
 * and one replayed alert day (Kayar, 2026-02-27), so every public page has something to show.
 * Nothing here touches the developer's own database or .env secrets.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../apps/server/src/lib/password.js';
import { E2E_PASSWORD, E2E_PORT } from './env.js';

const dir = join(tmpdir(), 'ndox-e2e');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(E2E_PORT),
  PUBLIC_BASE_URL: `http://localhost:${E2E_PORT}`,
  DATABASE_PATH: join(dir, 'ndox.db'),
  WALLET_MODE: 'fake',
  NOSTR_PUBLISH: 'false',
  SCHEDULER: 'false',
  WEB_DIST_DIR: 'apps/web/dist',
  ADMIN_PASSWORD_HASH: await hashPassword(E2E_PASSWORD),
  LOG_LEVEL: 'warn',
};
const cli = (...args: string[]) =>
  execFileSync('pnpm', ['-s', 'exec', 'tsx', 'apps/server/src/cli.ts', ...args], {
    env,
    stdio: 'inherit',
  });

cli('seed-demo', '--per-site', '2');
cli('replay', '--site', 'kayar', '--date', '2026-02-27');

const server = spawn('pnpm', ['-s', 'exec', 'tsx', 'apps/server/src/index.ts'], {
  env,
  stdio: 'inherit',
});
const stop = () => server.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));
