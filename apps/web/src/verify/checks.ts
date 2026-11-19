/**
 * In-browser verification (docs/BRIEF.md §10.4): every check is recomputed here from public data,
 * with the same oracle code the payout engine runs. Loaded lazily (crypto stays off first load).
 */
import {
  parseAnnouncement,
  parseAttestation,
  verifyAttestationEvent,
  verifyEvent,
  type AnnouncementContent,
  type AttestationContent,
  type NostrEvent,
} from '@ndox/oracle';
import { decideOutcome, parseMarineResponse, seriesFromResponse, windowStats } from '@ndox/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AttestationDetail, Meta, Outcome } from '../lib/api';

export type CheckId = 'relays' | 'nonce' | 'signature' | 'data' | 'rule' | 'payments';
export type CheckState = 'running' | 'ok' | 'fail' | 'skip';

export type CheckResult =
  | { id: 'relays'; state: 'ok'; found: number; asked: number }
  | { id: 'relays'; state: 'skip'; reason: 'replay' | 'dry_run' }
  | { id: 'relays'; state: 'fail'; asked: number }
  | { id: 'nonce'; state: 'ok' | 'fail'; committedAt: string; windowStart: string }
  | { id: 'signature'; state: 'ok' | 'fail'; oraclePubkey: string; failed: string[] }
  | { id: 'data'; state: 'ok' | 'fail' | 'skip'; checked: number; failed: string[] }
  | { id: 'rule'; state: 'ok' | 'fail'; recomputed: Outcome; signed: string }
  | { id: 'payments'; state: 'ok' | 'fail' | 'skip'; valid: number; total: number };

export const CHECK_ORDER: CheckId[] = ['relays', 'nonce', 'signature', 'data', 'rule', 'payments'];

/** Unparseable events: every check fails (nothing can be trusted). */
export function parseFailure(): CheckResult[] {
  return [
    { id: 'relays', state: 'fail', asked: 0 },
    { id: 'nonce', state: 'fail', committedAt: '', windowStart: '' },
    { id: 'signature', state: 'fail', oraclePubkey: '', failed: ['parse'] },
    { id: 'data', state: 'fail', checked: 0, failed: [] },
    { id: 'rule', state: 'fail', recomputed: 'indisponible', signed: '' },
    { id: 'payments', state: 'fail', valid: 0, total: 0 },
  ];
}

interface Parsed {
  ann: { event: NostrEvent; content: AnnouncementContent };
  att: { event: NostrEvent; content: AttestationContent };
}

export function parseDetail(d: AttestationDetail): Parsed | null {
  if (!d.attestation) return null;
  return {
    ann: parseAnnouncement(d.announcement.event),
    att: parseAttestation(d.attestation.event),
  };
}

/** Signatures, oracle key, link between the two events, nonce commitment timing. */
export function checkOracle(
  d: AttestationDetail,
  meta: Pick<Meta, 'oraclePubkey' | 'demoOraclePubkey'>,
): [CheckResult, CheckResult] {
  const expected = d.replay ? meta.demoOraclePubkey : meta.oraclePubkey;
  const report = verifyAttestationEvent(d.announcement.event, d.attestation!.event, {
    expectedOraclePubkey: expected,
  });
  const nonce = report.checks.find((c) => c.id === 'nonce_committed_before_window');
  const ann = report.announcement;
  const nonceResult: CheckResult = {
    id: 'nonce',
    state: nonce?.ok ? 'ok' : 'fail',
    committedAt: new Date(d.announcement.event.created_at * 1000).toISOString(),
    windowStart: ann?.window.start ?? '',
  };
  const failed = report.checks
    .filter((c) => c.id !== 'nonce_committed_before_window' && !c.ok)
    .map((c) => c.id as string);
  if (report.error) failed.push(report.error);
  const sig: CheckResult = {
    id: 'signature',
    state: failed.length === 0 && report.checks.length > 0 ? 'ok' : 'fail',
    oraclePubkey: expected,
    failed,
  };
  return [nonceResult, sig];
}

/** The trigger rule from the announcement, applied to the data published in the attestation. */
export function checkRule(p: Parsed): CheckResult {
  const rule = p.ann.content.rule;
  const recomputed = decideOutcome(
    { thresholdM: rule.thresholdM, minValidHours: rule.minValidHours, models: rule.models },
    p.att.content.data.models,
  );
  return {
    id: 'rule',
    state: recomputed === p.att.content.outcome ? 'ok' : 'fail',
    recomputed,
    signed: p.att.content.outcome,
  };
}

export const sha256Hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/**
 * Each model's archived raw response: its SHA-256 must be the one signed, and the window
 * maximum recomputed from it must be the published value.
 */
export async function checkData(
  d: AttestationDetail,
  p: Parsed,
  fetchRaw: (url: string) => Promise<string>,
): Promise<CheckResult> {
  const failed: string[] = [];
  let checked = 0;
  for (const m of p.att.content.data.models) {
    const rec = d.forecasts.find((f) => f.model === m.id);
    if (!rec?.rawUrl) {
      failed.push(m.id);
      continue;
    }
    try {
      const body = await fetchRaw(rec.rawUrl);
      checked++;
      if (sha256Hex(utf8ToBytes(body)) !== m.sha256) {
        failed.push(m.id);
        continue;
      }
      const series = seriesFromResponse(parseMarineResponse(body), p.ann.content.rule.variable);
      const stats = windowStats(series.time, series.values, p.ann.content.window);
      if (stats.windowMaxM !== m.windowMaxM || stats.validHours !== m.validHours) failed.push(m.id);
    } catch {
      failed.push(m.id);
    }
  }
  if (p.att.content.data.models.length === 0) return { id: 'data', state: 'skip', checked, failed };
  return { id: 'data', state: failed.length ? 'fail' : 'ok', checked, failed };
}

export function preimageMatches(preimageHex: string, paymentHashHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(preimageHex) || !/^[0-9a-f]{64}$/.test(paymentHashHex)) return false;
  return sha256Hex(hexToBytes(preimageHex)) === paymentHashHex;
}

/** Every paid payout: sha256(preimage) = payment hash, and a valid receipt signed by the pool. */
export function checkPayments(d: AttestationDetail, poolPubkey: string): CheckResult {
  const paid = d.payouts.filter((x) => x.status === 'paid');
  let valid = 0;
  for (const x of paid) {
    const proofOk = !!x.preimage && !!x.paymentHash && preimageMatches(x.preimage, x.paymentHash);
    const receiptOk = !x.receipt || (x.receipt.pubkey === poolPubkey && verifyEvent(x.receipt));
    if (proofOk && receiptOk) valid++;
  }
  if (paid.length === 0) return { id: 'payments', state: 'skip', valid: 0, total: 0 };
  return {
    id: 'payments',
    state: valid === paid.length ? 'ok' : 'fail',
    valid,
    total: paid.length,
  };
}

export type RelayQuery = (relay: string, id: string) => Promise<NostrEvent | null>;

/** Is the commitment really on the public relays (and identical)? */
export async function checkRelays(
  d: AttestationDetail,
  meta: Pick<Meta, 'relays' | 'nostrPublish'>,
  query: RelayQuery,
): Promise<CheckResult> {
  if (d.replay) return { id: 'relays', state: 'skip', reason: 'replay' };
  if (!meta.nostrPublish && !d.announcement.publishedAt)
    return { id: 'relays', state: 'skip', reason: 'dry_run' };
  const id = d.announcement.event.id;
  const results = await Promise.all(
    meta.relays.map((r) =>
      query(r, id).then(
        (e) => !!e && e.id === id && verifyEvent(e),
        () => false,
      ),
    ),
  );
  const found = results.filter(Boolean).length;
  return found > 0
    ? { id: 'relays', state: 'ok', found, asked: meta.relays.length }
    : { id: 'relays', state: 'fail', asked: meta.relays.length };
}

/** Real relay lookup with nostr-tools (one relay at a time, short timeout). */
export const nostrRelayQuery: RelayQuery = async (relay, id) => {
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  try {
    const events = await pool.querySync([relay], { ids: [id] }, { maxWait: 6000 });
    return (events[0] as NostrEvent | undefined) ?? null;
  } finally {
    pool.close([relay]);
  }
};
