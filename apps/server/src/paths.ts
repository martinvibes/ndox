import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in apps/server/src (dev) or is bundled into apps/server/dist (build):
// either way the server root is one level up.
const here = dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '../..');

export const DEFAULT_PATHS = {
  databasePath: resolve(REPO_ROOT, 'data/ndox.sqlite'),
  webDir: resolve(REPO_ROOT, 'apps/web/dist'),
  seedDir: resolve(REPO_ROOT, 'data/seed'),
  migrationsDir: resolve(SERVER_ROOT, 'drizzle'),
};
