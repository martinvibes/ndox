/**
 * Environment configuration (zod-validated). See .env.example.
 *
 * WALLET_MODE=fake: empty secrets are generated once and persisted next to the database
 * (secrets.json, mode 0600) so `docker compose up` works on a clean machine.
 * WALLET_MODE=nwc: every secret must be provided; the server refuses to start otherwise.
 * Secret values are never logged.
 */
import { getPublicKey } from '@ndox/oracle';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parsePasswordHash, PasswordHashError } from './lib/password.js';
import { DEFAULT_PATHS } from './paths.js';

const HEX32 = /^[0-9a-f]{64}$/;
const hex32 = z.string().regex(HEX32, 'must be 32 bytes of lowercase hex');
const bool = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()))
  .pipe(z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_BASE_URL: z.url().default('http://localhost:8080'),
  DATABASE_PATH: z.string().min(1).optional(),
  ORACLE_SECRET: hex32.optional(),
  DEMO_ORACLE_SECRET: hex32.optional(),
  POOL_SECRET: hex32.optional(),
  SESSION_SECRET: hex32.optional(),
  PII_ENCRYPTION_KEY: hex32.optional(),
  WALLET_MODE: z.enum(['fake', 'nwc']).default('fake'),
  NWC_URL: z.string().startsWith('nostr+walletconnect://').optional(),
  NETWORK_LABEL: z.enum(['mainnet', 'mutinynet', 'regtest', 'test']).default('mainnet'),
  TEST_PAYER_NWC_URL: z.string().startsWith('nostr+walletconnect://').optional(),
  TEST_FAUCET_URL: z.url().default('https://faucet.nwc.dev'),
  DAILY_PAYOUT_CAP_SATS: z.coerce.number().int().min(0).default(20_000),
  RESERVE_FLOOR_SATS: z.coerce.number().int().min(0).default(0),
  NOSTR_RELAYS: z
    .string()
    .default('wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
    .transform((s) =>
      s
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^wss?:\/\/[^\s,]+$/, 'relay must be a ws(s):// URL')).min(1)),
  NOSTR_PUBLISH: bool.default(false),
  DEFAULT_THRESHOLD_M: z.coerce.number().positive().max(20).default(2.5),
  PAYOUT_FCFA: z.coerce.number().int().positive().default(2000),
  WAITING_HOURS: z.coerce.number().int().min(0).default(72),
  PREMIUM_LOADING: z.coerce.number().min(0).max(5).default(0.25),
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  POOL_LIGHTNING_ADDRESS: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'must be a Lightning address')
    .optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  AT_USERNAME: z.string().min(1).default('sandbox'),
  AT_API_KEY: z.string().min(1).optional(),
  HEALTHCHECK_URL: z.url().optional(),
  SCHEDULER: bool.default(true),
  WEB_DIST_DIR: z.string().min(1).optional(),
  SEED_DIR: z.string().min(1).optional(),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const SECRET_NAMES = [
  'ORACLE_SECRET',
  'DEMO_ORACLE_SECRET',
  'POOL_SECRET',
  'SESSION_SECRET',
  'PII_ENCRYPTION_KEY',
] as const;
type SecretName = (typeof SECRET_NAMES)[number];

export interface Secrets {
  oracle: string;
  demoOracle: string;
  pool: string;
  session: string;
  pii: string;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  secrets: Secrets;
  /** Set when some secrets were generated (fake mode only). */
  generatedSecretsFile: string | undefined;
  walletMode: 'fake' | 'nwc';
  nwcUrl: string | undefined;
  network: 'mainnet' | 'mutinynet' | 'regtest' | 'test';
  /**
   * An NWC wallet on a test network (NETWORK_LABEL≠mainnet): real Lightning payments of sats
   * that have no value. Such a pool may pay demo crews; a mainnet wallet never does.
   */
  testFunds: boolean;
  /**
   * Test networks only: a second NWC wallet that pays an invoice when someone presses
   * "Payer avec le portefeuille de test". Never accepted on mainnet (it would spend real sats).
   */
  testPayerNwcUrl: string | undefined;
  /** NWC faucet used to create test wallets for demo crews (NETWORK_LABEL=test). */
  testFaucetUrl: string;
  dailyPayoutCapSats: number;
  reserveFloorSats: number;
  relays: string[];
  nostrPublish: boolean;
  defaultThresholdM: number;
  payoutFcfa: number;
  waitingHours: number;
  premiumLoading: number;
  adminPasswordHash: string | undefined;
  /** lud16 of the pool's Nostr profile (zaps); must be served by the pool's NWC wallet. */
  poolLightningAddress: string | undefined;
  anthropic: { apiKey: string | undefined; model: string };
  africasTalking: { username: string; apiKey: string | undefined };
  healthcheckUrl: string | undefined;
  scheduler: boolean;
  webDir: string;
  seedDir: string;
  migrationsDir: string;
  logLevel: string;
}

export class ConfigError extends Error {}

/** Drops unset and blank values so that `KEY=` in .env means "use the default". */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
  defaults: Partial<typeof DEFAULT_PATHS> = {},
): Config {
  const paths = { ...DEFAULT_PATHS, ...defaults };
  const parsed = EnvSchema.safeParse(cleanEnv(rawEnv));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid environment: ${issues}`);
  }
  const e = parsed.data;
  if (e.ADMIN_PASSWORD_HASH) {
    try {
      parsePasswordHash(e.ADMIN_PASSWORD_HASH);
    } catch (err) {
      if (err instanceof PasswordHashError) throw new ConfigError(err.message);
      throw err;
    }
  }
  const databasePath = e.DATABASE_PATH ? resolve(e.DATABASE_PATH) : paths.databasePath;

  const provided: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) if (e[name]) provided[name] = e[name];

  let generatedSecretsFile: string | undefined;
  let secretValues: Record<SecretName, string>;
  if (e.WALLET_MODE === 'nwc') {
    const missing: string[] = SECRET_NAMES.filter((n) => !provided[n]);
    if (!e.NWC_URL) missing.push('NWC_URL');
    if (!e.ADMIN_PASSWORD_HASH) missing.push('ADMIN_PASSWORD_HASH');
    if (missing.length > 0) {
      throw new ConfigError(`WALLET_MODE=nwc requires: ${missing.join(', ')}`);
    }
    if (e.TEST_PAYER_NWC_URL && e.NETWORK_LABEL === 'mainnet')
      throw new ConfigError('TEST_PAYER_NWC_URL is for test networks only (NETWORK_LABEL=mainnet)');
    if (e.TEST_PAYER_NWC_URL && e.TEST_PAYER_NWC_URL === e.NWC_URL)
      throw new ConfigError('TEST_PAYER_NWC_URL must be a different wallet from NWC_URL');
    secretValues = provided as Record<SecretName, string>;
  } else {
    const res = fillSecrets(provided, join(dirname(databasePath), 'secrets.json'));
    secretValues = res.values;
    generatedSecretsFile = res.file;
  }

  const secrets: Secrets = {
    oracle: secretValues.ORACLE_SECRET,
    demoOracle: secretValues.DEMO_ORACLE_SECRET,
    pool: secretValues.POOL_SECRET,
    session: secretValues.SESSION_SECRET,
    pii: secretValues.PII_ENCRYPTION_KEY,
  };
  validateSecrets(secrets);

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    databasePath,
    secrets,
    generatedSecretsFile,
    walletMode: e.WALLET_MODE,
    nwcUrl: e.NWC_URL,
    network: e.NETWORK_LABEL,
    testFunds: e.WALLET_MODE === 'nwc' && e.NETWORK_LABEL !== 'mainnet',
    testPayerNwcUrl: e.WALLET_MODE === 'nwc' ? e.TEST_PAYER_NWC_URL : undefined,
    testFaucetUrl: e.TEST_FAUCET_URL.replace(/\/+$/, ''),
    dailyPayoutCapSats: e.DAILY_PAYOUT_CAP_SATS,
    reserveFloorSats: e.RESERVE_FLOOR_SATS,
    relays: e.NOSTR_RELAYS,
    nostrPublish: e.NOSTR_PUBLISH,
    defaultThresholdM: e.DEFAULT_THRESHOLD_M,
    payoutFcfa: e.PAYOUT_FCFA,
    waitingHours: e.WAITING_HOURS,
    premiumLoading: e.PREMIUM_LOADING,
    adminPasswordHash: e.ADMIN_PASSWORD_HASH,
    poolLightningAddress: e.POOL_LIGHTNING_ADDRESS,
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
    africasTalking: { username: e.AT_USERNAME, apiKey: e.AT_API_KEY },
    healthcheckUrl: e.HEALTHCHECK_URL,
    scheduler: e.SCHEDULER,
    webDir: e.WEB_DIST_DIR ? resolve(e.WEB_DIST_DIR) : paths.webDir,
    seedDir: e.SEED_DIR ? resolve(e.SEED_DIR) : paths.seedDir,
    migrationsDir: e.MIGRATIONS_DIR ? resolve(e.MIGRATIONS_DIR) : paths.migrationsDir,
    logLevel: e.LOG_LEVEL,
  };
}

/** Provided values win; missing ones come from (or are generated into) the secrets file. */
function fillSecrets(
  provided: Partial<Record<SecretName, string>>,
  file: string,
): { values: Record<SecretName, string>; file: string | undefined } {
  let stored: Partial<Record<SecretName, string>> = {};
  if (existsSync(file)) {
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const parsed = z.partialRecord(z.enum(SECRET_NAMES), hex32).safeParse(json);
    if (!parsed.success) throw new ConfigError(`${file} is not a valid secrets file`);
    stored = parsed.data;
  }
  const values = {} as Record<SecretName, string>;
  let changed = false;
  for (const name of SECRET_NAMES) {
    const v = provided[name] ?? stored[name];
    if (v) {
      values[name] = v;
    } else {
      values[name] = randomSecret();
      stored[name] = values[name];
      changed = true;
    }
  }
  if (changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const usesFile = SECRET_NAMES.some((n) => !provided[n]);
  return { values, file: usesFile ? file : undefined };
}

/** A uniformly random valid secp256k1 secret key. */
function randomSecret(): string {
  for (;;) {
    const hex = randomBytes(32).toString('hex');
    try {
      getPublicKey(hex);
      return hex;
    } catch {
      // out of range (probability ~2^-128); draw again
    }
  }
}

function validateSecrets(s: Secrets): void {
  for (const [name, hex] of [
    ['ORACLE_SECRET', s.oracle],
    ['DEMO_ORACLE_SECRET', s.demoOracle],
    ['POOL_SECRET', s.pool],
  ] as const) {
    try {
      getPublicKey(hex);
    } catch {
      throw new ConfigError(`${name} is not a valid secp256k1 secret key`);
    }
  }
  const keys = [s.oracle, s.demoOracle, s.pool, s.session, s.pii];
  if (new Set(keys).size !== keys.length) {
    throw new ConfigError(
      'ORACLE_SECRET, DEMO_ORACLE_SECRET, POOL_SECRET, SESSION_SECRET and PII_ENCRYPTION_KEY must all differ',
    );
  }
  const pubs = [s.oracle, s.demoOracle, s.pool].map(getPublicKey);
  if (new Set(pubs).size !== pubs.length) {
    throw new ConfigError('oracle, demo oracle and pool keys must have different public keys');
  }
}
