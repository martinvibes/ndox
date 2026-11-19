/**
 * SQLite schema (Drizzle). Conventions:
 * - money is INTEGER (sats, FCFA); never REAL
 * - timestamps are ISO-8601 UTC strings ("2026-02-27T05:15:00Z"); dates are "YYYY-MM-DD"
 * - PII (phone, Lightning address) is stored only AES-GCM-sealed (see lib/box.ts)
 * Keep this file free of workspace imports: drizzle-kit loads it on its own.
 */
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`;
const createdAt = () => text('created_at').notNull().default(nowIso);
const bool = (name: string) => integer(name, { mode: 'boolean' });

export const OUTCOME_VALUES = ['calme', 'danger', 'indisponible'] as const;

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(nowIso),
});

/** Per-site runtime settings; static facts (name, coordinates, season) live in @ndox/shared. */
export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  /** Trigger threshold in centimetres (integer; 250 = 2.5 m). */
  thresholdCm: integer('threshold_cm').notNull(),
  enabled: bool('enabled').notNull().default(true),
  updatedAt: text('updated_at').notNull().default(nowIso),
});

export const crews = sqliteTable(
  'crews',
  {
    id: text('id').primaryKey(),
    site: text('site')
      .notNull()
      .references(() => sites.id),
    /** Public pseudonym (e.g. "Pirogue K-07"); never a real name. */
    pseudonym: text('pseudonym').notNull().unique(),
    /** 6-character code for the status page / USSD. */
    statusCode: text('status_code').notNull().unique(),
    phoneEnc: text('phone_enc'),
    lnAddressEnc: text('ln_address_enc'),
    /** Salt for the public holder commitment sha256(salt || crewId). */
    holderSalt: text('holder_salt').notNull(),
    demo: bool('demo').notNull().default(true),
    active: bool('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('crews_site_idx').on(t.site)],
);

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    crewId: text('crew_id')
      .notNull()
      .references(() => crews.id),
    site: text('site')
      .notNull()
      .references(() => sites.id),
    payoutFcfa: integer('payout_fcfa').notNull(),
    thresholdCm: integer('threshold_cm').notNull(),
    premiumFcfa: integer('premium_fcfa').notNull(),
    fundedBy: text('funded_by', { enum: ['crew', 'clpa', 'sponsor'] }).notNull(),
    status: text('status', { enum: ['pending', 'active', 'expired', 'cancelled'] })
      .notNull()
      .default('pending'),
    paidAt: text('paid_at'),
    activeFrom: text('active_from'),
    activeUntil: text('active_until'),
    demo: bool('demo').notNull().default(true),
    eventJson: text('event_json'),
    publishedAt: text('published_at'),
    createdAt: createdAt(),
  },
  (t) => [index('policies_site_status_idx').on(t.site, t.status)],
);

export const replayRuns = sqliteTable('replay_runs', {
  id: text('id').primaryKey(),
  site: text('site').notNull(),
  date: text('date').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  detail: text('detail', { mode: 'json' }),
  createdAt: createdAt(),
});

export const announcements = sqliteTable(
  'announcements',
  {
    /** ndox:<site>:<date> or ndox-replay:<site>:<date>:<runId> */
    eventId: text('event_id').primaryKey(),
    site: text('site').notNull(),
    date: text('date').notNull(),
    replayRunId: text('replay_run_id').references(() => replayRuns.id),
    oraclePubkey: text('oracle_pubkey').notNull(),
    noncePoint: text('nonce_point').notNull(),
    /** Sealed secret nonce k; set to NULL in the same transaction that stores the attestation. */
    nonceEnc: text('nonce_enc'),
    nostrId: text('nostr_id').notNull().unique(),
    eventJson: text('event_json').notNull(),
    /** Event created_at (ISO). */
    createdAt: text('created_at').notNull(),
    publishedAt: text('published_at'),
    publishResult: text('publish_result', { mode: 'json' }),
  },
  (t) => [index('announcements_site_date_idx').on(t.site, t.date)],
);

export const forecasts = sqliteTable(
  'forecasts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: text('event_id')
      .notNull()
      .references(() => announcements.eventId),
    model: text('model').notNull(),
    url: text('url').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    fetchedAt: text('fetched_at').notNull(),
    sha256: text('sha256'),
    /** Raw response body, byte-for-byte as received (its SHA-256 is published). */
    body: text('body'),
    windowMaxM: real('window_max_m'),
    validHours: integer('valid_hours').notNull().default(0),
    error: text('error'),
  },
  (t) => [uniqueIndex('forecasts_event_model_uq').on(t.eventId, t.model)],
);

export const attestations = sqliteTable(
  'attestations',
  {
    eventId: text('event_id')
      .primaryKey()
      .references(() => announcements.eventId),
    site: text('site').notNull(),
    date: text('date').notNull(),
    replayRunId: text('replay_run_id').references(() => replayRuns.id),
    outcome: text('outcome', { enum: OUTCOME_VALUES }).notNull(),
    /** min over models of the window max (the value compared with the threshold). */
    decisiveM: real('decisive_m'),
    nostrId: text('nostr_id').notNull().unique(),
    eventJson: text('event_json').notNull(),
    createdAt: text('created_at').notNull(),
    publishedAt: text('published_at'),
    publishResult: text('publish_result', { mode: 'json' }),
  },
  (t) => [index('attestations_site_date_idx').on(t.site, t.date)],
);

export const payouts = sqliteTable(
  'payouts',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id),
    attestationId: text('attestation_id')
      .notNull()
      .references(() => attestations.eventId),
    site: text('site').notNull(),
    amountFcfa: integer('amount_fcfa').notNull(),
    /** Full amount due before any pro-rata reduction. */
    dueSat: integer('due_sat').notNull(),
    amountSat: integer('amount_sat').notNull(),
    /** Price used: XOF per BTC (integer). */
    xofPerBtc: integer('xof_per_btc').notNull(),
    /** Pro-rata factor in parts per million (1_000_000 = paid in full). */
    factorPpm: integer('factor_ppm').notNull(),
    status: text('status', { enum: ['pending', 'paying', 'paid', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    invoice: text('invoice'),
    paymentHash: text('payment_hash'),
    preimage: text('preimage'),
    error: text('error'),
    receiptJson: text('receipt_json'),
    receiptPublishedAt: text('receipt_published_at'),
    replay: bool('replay').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('payouts_policy_attestation_uq').on(t.policyId, t.attestationId),
    index('payouts_status_idx').on(t.status),
  ],
);

export const deposits = sqliteTable(
  'deposits',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['premium', 'levy', 'sponsor', 'zap'] }).notNull(),
    status: text('status', { enum: ['pending', 'paid', 'expired'] })
      .notNull()
      .default('pending'),
    amountSat: integer('amount_sat').notNull(),
    amountFcfa: integer('amount_fcfa'),
    xofPerBtc: integer('xof_per_btc'),
    paymentHash: text('payment_hash').unique(),
    invoice: text('invoice'),
    zapReceiptId: text('zap_receipt_id').unique(),
    policyId: text('policy_id').references(() => policies.id),
    crewId: text('crew_id').references(() => crews.id),
    site: text('site'),
    memo: text('memo'),
    demo: bool('demo').notNull().default(true),
    createdAt: createdAt(),
    paidAt: text('paid_at'),
    expiresAt: text('expires_at'),
  },
  (t) => [index('deposits_status_idx').on(t.status)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    crewId: text('crew_id')
      .notNull()
      .references(() => crews.id),
    attestationId: text('attestation_id')
      .notNull()
      .references(() => attestations.eventId),
    channel: text('channel', { enum: ['sms'] }).notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    providerId: text('provider_id'),
    error: text('error'),
    createdAt: createdAt(),
    sentAt: text('sent_at'),
  },
  (t) => [
    uniqueIndex('notifications_crew_attestation_channel_uq').on(
      t.crewId,
      t.attestationId,
      t.channel,
    ),
  ],
);

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    job: text('job').notNull(),
    site: text('site'),
    date: text('date'),
    status: text('status', { enum: ['ok', 'skipped', 'error'] }).notNull(),
    /** Short machine-readable detail; never PII or secrets. */
    detail: text('detail'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
  },
  (t) => [index('job_runs_job_started_idx').on(t.job, t.startedAt)],
);
