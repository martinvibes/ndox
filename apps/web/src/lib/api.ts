/**
 * Typed client for the Ndox API (apps/server/src/api). Same origin: the server serves this app,
 * and Vite proxies /api in development.
 */
import type { NostrEvent } from '@ndox/oracle';

export type Outcome = 'calme' | 'danger' | 'indisponible';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let detail: string | undefined;
    try {
      const j = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof j.error === 'string') code = j.error;
      if (typeof j.message === 'string') detail = j.message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, code, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {}),
  send: <T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, csrf?: string) =>
    request<T>(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(csrf ? { headers: { 'x-csrf-token': csrf } } : {}),
    }),
};

// ── public ──────────────────────────────────────────────────────────────────────────────────

export interface Meta {
  oraclePubkey: string;
  demoOraclePubkey: string;
  poolPubkey: string;
  relays: string[];
  nostrPublish: boolean;
  network: string;
  walletMode: 'fake' | 'nwc';
  poolLightningAddress: string | null;
  schedule: { announce: string; fetch: string; attest: string };
  window: { start: string; end: string; timezone: string };
}

export interface ModelValue {
  id: string;
  windowMaxM: number | null;
  validHours: number;
}

export interface AttestationSummary {
  eventId: string;
  site: string;
  date: string;
  replay: boolean;
  replayRunId: string | null;
  outcome: Outcome;
  decisiveM: number | null;
  nostrId: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface TodaySite {
  id: string;
  name: string;
  thresholdM: number;
  enabled: boolean;
  inSeason: boolean;
  announcement: {
    eventId: string;
    nostrId: string;
    noncePoint: string;
    createdAt: string;
    publishedAt: string | null;
    attestAt: string;
  } | null;
  attestation: (AttestationSummary & { models: ModelValue[] }) | null;
  tomorrow: { eventId: string; createdAt: string; publishedAt: string | null } | null;
}

export interface Today {
  date: string;
  now: string;
  sites: TodaySite[];
}

export interface SiteCoverage {
  site: string;
  covered: number;
  waiting: number;
  worstWeekDangerDays: number;
  exposureSat: number | null;
  season: { id: string; from: string; to: string; payouts: number; sat: number } | null;
}

export interface Pool {
  asOf: string;
  wallet: { kind: 'fake' | 'nwc'; simulated: boolean; network: string };
  balanceSat: number | null;
  balanceFcfa: number | null;
  outstandingSat: number;
  reserveFloorSat: number;
  availableSat: number | null;
  dailyCapSat: number;
  paidTodaySat: number;
  payoutFcfa: number;
  price: {
    eurPerBtc: number;
    xofPerBtc: number;
    asOf: string;
    source: 'mempool.space' | 'seed';
    stale: boolean;
  } | null;
  coverage: { ratio: number | null; exposureSat: number | null; sites: SiteCoverage[] };
  policies: { covered: number; waiting: number; awaitingPremium: number };
  payouts: { count: number; sat: number; seasonCount: number; seasonSat: number; failed: number };
  deposits: { premium: number; levy: number; sponsor: number; zap: number };
  shortfalls: {
    attestationId: string;
    site: string;
    date: string;
    dueSat: number;
    planSat: number;
    shortfallSat: number;
    factorPpm: number | null;
    limitedBy: string | null;
  }[];
}

export interface PayoutProof {
  id: string;
  policyId: string;
  amountFcfa: number;
  dueSat: number;
  amountSat: number;
  factorPpm: number | null;
  status: 'pending' | 'paying' | 'paid' | 'failed';
  paymentHash: string | null;
  preimage: string | null;
  simulated: boolean;
  receipt: NostrEvent | null;
  createdAt: string;
}

export interface ForecastRecord {
  model: string;
  url: string;
  status: string;
  fetchedAt: string;
  sha256: string | null;
  windowMaxM: number | null;
  validHours: number | null;
  error: string | null;
  rawUrl: string | null;
}

export interface AttestationDetail {
  eventId: string;
  site: string;
  date: string;
  replay: boolean;
  replayRunId: string | null;
  announcement: {
    event: NostrEvent;
    nostrId: string;
    createdAt: string;
    publishedAt: string | null;
  };
  attestation: {
    event: NostrEvent;
    nostrId: string;
    outcome: Outcome;
    decisiveM: number | null;
    createdAt: string;
    publishedAt: string | null;
  } | null;
  forecasts: ForecastRecord[];
  payoutRun: {
    status: 'planned' | 'no_payout' | 'invalid';
    simulated: boolean;
    policies: number;
    dueSat: number;
    planSat: number;
    shortfallSat: number;
    factorPpm: number | null;
    limitedBy: 'balance' | 'daily_cap' | null;
    event: NostrEvent | null;
  } | null;
  payouts: PayoutProof[];
}

export interface PublicPayout {
  id: string;
  site: string;
  date: string;
  attestationId: string;
  amountFcfa: number;
  amountSat: number;
  dueSat: number;
  factorPpm: number | null;
  status: string;
  paymentHash: string | null;
  preimage: string | null;
  paidAt: string | null;
  simulated: boolean;
}

export interface SponsorInvoice {
  paymentHash: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
  amountSat: number;
  amountFcfa: number;
  xofPerBtc: number;
  site: string | null;
  crew: string | null;
  cover: { activeFrom: string; activeUntil: string } | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  simulated: boolean;
  invoice?: string;
  coverWeeks?: number | null;
}

export interface OutlookDay {
  date: string;
  outcome: Outcome;
  decisiveM: number | null;
  models: ModelValue[];
}

export interface Outlook {
  site: string;
  generatedAt: string;
  attested: false;
  thresholdM: number;
  sources: { model: string; url: string; fetchedAt: string; sha256: string }[];
  days: OutlookDay[];
}

export interface Backtest {
  generatedAt: string;
  params: {
    historyModel: string;
    liveModels: string[];
    variable: string;
    windowUtc: [number, number];
    minValidHours: number;
    payoutFcfa: number;
    loading: number;
    years: [number, number];
  };
  caveat: string;
  sites: {
    site: string;
    name: string;
    thresholdM: number;
    seasonMonths: number[];
    seasons: { season: string; dangerDays: number; missingDays: number }[];
    summary: { n: number; mean: number; p90: number; worst: number; best: number };
    weeksInSeason: number;
    premiumWeeklyFcfa: number;
    reservePerPolicyFcfa: number;
    worstWeekDangerDays: number;
  }[];
  alertCheck: {
    note: string;
    rows: {
      date: string;
      site: string;
      zone: string;
      source: string;
      url: string;
      era5MaxM: number | null;
      era5Fired: boolean | null;
      live: { id: string; windowMaxM: number | null }[];
      liveOutcome: Outcome;
    }[];
    era5: { matched: number; total: number; rate: number | null };
    live: { matched: number; total: number; rate: number | null };
  };
  calibration: {
    thresholdM: number;
    alertMatchEra5: { matched: number; total: number; rate: number | null };
    alertMatchLive: { matched: number; total: number; rate: number | null };
    sites: { site: string; meanDangerDaysPerSeason: number; premiumWeeklyFcfa: number }[];
  }[];
}

// ── admin ───────────────────────────────────────────────────────────────────────────────────

export type PolicyState = 'awaiting_premium' | 'waiting' | 'covered' | 'expired' | 'cancelled';

export interface AdminPolicy {
  id: string;
  crewId: string;
  site: string;
  state: PolicyState;
  payoutFcfa: number;
  thresholdM: number;
  premiumFcfa: number;
  weeks: number;
  fundedBy: 'crew' | 'clpa' | 'sponsor';
  paidAt: string | null;
  activeFrom: string | null;
  activeUntil: string | null;
  demo: boolean;
  nostrId: string | null;
  publishedAt: string | null;
  createdAt: string;
  crew?: string;
}

export interface AdminCrew {
  id: string;
  site: string;
  pseudonym: string;
  statusCode: string;
  demo: boolean;
  active: boolean;
  lnAddressHint: string | null;
  phoneHint: string | null;
  createdAt: string;
  policy: AdminPolicy | null;
}

export interface AdminDeposit {
  id: string;
  kind: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
  amountSat: number;
  amountFcfa: number;
  paymentHash: string | null;
  invoice: string | null;
  policyId: string | null;
  crew: string | null;
  site: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  simulated: boolean;
}

export interface AdminPayout {
  id: string;
  crew: string;
  site: string;
  attestationId: string;
  amountSat: number;
  dueSat: number;
  amountFcfa: number;
  factorPpm: number | null;
  status: 'pending' | 'paying' | 'paid' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  paymentHash: string | null;
  paidAt: string | null;
  simulated: boolean;
  createdAt: string;
}

export interface AdminAlert {
  level: 'error' | 'warning';
  code: string;
  at: string;
  count: number;
  detail: Record<string, string | number | null>;
}

export interface AdminSession {
  csrfToken: string;
  expiresAt: string;
  wallet?: { kind: string; simulated: boolean; network: string };
}

export interface PolicySettings {
  payoutFcfa: number;
  waitingHours: number;
  premiumLoading: number;
  dailyPayoutCapSats: number;
  reserveFloorSats: number;
}

export interface AdminSettings {
  policy: PolicySettings;
  defaults: PolicySettings;
  sites: { id: string; name: string; thresholdM: number; enabled: boolean; updatedAt: string }[];
  wallet: { kind: string; simulated: boolean; network: string };
}

export interface ReplayResult {
  replay: {
    runId: string;
    eventId: string;
    site: string;
    date: string;
    outcome: Outcome;
    decisiveM: number | null;
    steps: { step: 'announce' | 'fetch' | 'attest'; at: string; detail: Record<string, unknown> }[];
    verification: { ok: boolean; checks: { id: string; ok: boolean; detail?: string }[] };
  };
  payouts: {
    runId: string;
    eventId: string;
    status: string;
    simulated: true;
    at: string;
    openingSat: number;
    policies: number;
    dueSat: number;
    planSat: number;
    paidSat: number;
    shortfallSat: number;
    factorPpm: number | null;
    limitedBy: string | null;
    paid: number;
    failed: number;
    payouts: {
      policyId: string;
      pseudonym: string;
      amountSat: number;
      amountFcfa: number;
      status: string;
      paymentHash: string | null;
    }[];
  } | null;
}
