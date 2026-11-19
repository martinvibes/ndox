import { SITES } from '@ndox/shared';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export { schema };
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenDbOptions {
  migrationsDir: string;
  /** Threshold for sites that have no row yet (metres). */
  defaultThresholdM: number;
}

/** Opens (creating if needed) the SQLite database, applies migrations and seeds site rows. */
export function openDb(path: string, opts: OpenDbOptions): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: opts.migrationsDir });
  ensureSites(db, opts.defaultThresholdM);
  return db;
}

export function mToCm(m: number): number {
  return Math.round(m * 100);
}

export function cmToM(cm: number): number {
  return cm / 100;
}

/**
 * Inserts a row for every configured site that does not have one, at DEFAULT_THRESHOLD_M.
 * Existing rows (thresholds edited in the dashboard) are kept.
 */
function ensureSites(db: Db, defaultThresholdM: number): void {
  const rows = SITES.map((s) => ({ id: s.id, thresholdCm: mToCm(defaultThresholdM) }));
  db.insert(schema.sites).values(rows).onConflictDoNothing().run();
}
