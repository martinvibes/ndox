/**
 * Nostr (de)serialisation for Ndox oracle events.
 *
 * Uses the draft NIP-88 kinds (88 = oracle announcement, 89 = oracle attestation) with
 * DLC-style signatures. The content is JSON, not the dlcspecs TLV encoding (roadmap).
 * Event signing/verification is implemented with @noble only (NIP-01), so this package has
 * no server or Nostr-client dependencies.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { attest, getPublicKey, verifyAttestation, verifyOutcomeSignature } from './crypto.js';

export const KIND_ANNOUNCEMENT = 88;
export const KIND_ATTESTATION = 89;
export const OUTCOMES = ['calme', 'danger', 'indisponible'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const TAG_LIVE = 'ndox';
export const TAG_REPLAY = 'ndox-replay';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface RuleSpec {
  variable: 'wave_height' | 'swell_wave_height';
  thresholdM: number;
  models: string[];
  minValidHours: number;
  logic: string;
}

export interface AnnouncementContent {
  v: 1;
  eventId: string;
  site: string;
  window: { start: string; end: string };
  outcomes: string[];
  rule: RuleSpec;
  oraclePubkey: string;
  noncePoint: string;
  attestAt: string;
}

export interface ModelObservation {
  id: string;
  windowMaxM: number | null;
  validHours: number;
  url: string;
  sha256: string;
}

export interface AttestationData {
  fetchedAt: string;
  models: ModelObservation[];
}

export interface AttestationContent {
  v: 1;
  eventId: string;
  outcome: string;
  noncePoint: string;
  s: string;
  data: AttestationData;
}

// ---------------------------------------------------------------------------
// NIP-01 primitives

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9-]{1,40}$/;

export function getEventHash(e: EventTemplate & { pubkey: string }): string {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

export function finalizeEvent(template: EventTemplate, secretHex: string): NostrEvent {
  const pubkey = getPublicKey(secretHex);
  const unsigned = { ...template, pubkey };
  const id = getEventHash(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretHex)));
  return {
    id,
    pubkey,
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
    sig,
  };
}

function isEventShape(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    typeof o.sig === 'string' &&
    typeof o.content === 'string' &&
    Number.isInteger(o.kind) &&
    Number.isInteger(o.created_at) &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  );
}

/** NIP-01 id + BIP340 signature check. Never throws. */
export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (!isEventShape(e) || !HEX32.test(e.pubkey) || !HEX32.test(e.id) || !HEX64.test(e.sig)) {
      return false;
    }
    if (getEventHash(e) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

export function getTag(e: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1];
}

export function isReplayEvent(e: Pick<NostrEvent, 'tags'>): boolean {
  return e.tags.some((t) => t[0] === 't' && t[1] === TAG_REPLAY);
}

// ---------------------------------------------------------------------------
// Builders

export function eventIdFor(site: string, date: string, replayRunId?: string): string {
  if (!SLUG.test(site)) throw new Error('invalid site id');
  if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD');
  if (replayRunId === undefined) return `ndox:${site}:${date}`;
  if (!SLUG.test(replayRunId)) throw new Error('invalid replay run id');
  return `ndox-replay:${site}:${date}:${replayRunId}`;
}

export interface BuildAnnouncementParams {
  secret: string;
  site: string;
  /** Day D (YYYY-MM-DD, UTC). */
  date: string;
  noncePoint: string;
  rule: RuleSpec;
  /** Unix seconds. */
  createdAt: number;
  relays?: string[];
  /** Window in UTC hours [startHour, endHour). Default 06–18. */
  windowHours?: [number, number];
  /** UTC "HH:MM" when the attestation is due. Default 05:15. */
  attestTime?: string;
  siteName?: string;
  /** Set for demo replays: separate event id namespace and `ndox-replay` tag. */
  replayRunId?: string | undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function buildAnnouncement(p: BuildAnnouncementParams): {
  event: NostrEvent;
  content: AnnouncementContent;
} {
  const eventId = eventIdFor(p.site, p.date, p.replayRunId);
  const [h0, h1] = p.windowHours ?? [6, 18];
  if (!(h0 >= 0 && h1 <= 24 && h0 < h1)) throw new Error('invalid window');
  const attestTime = p.attestTime ?? '05:15';
  if (!/^\d{2}:\d{2}$/.test(attestTime)) throw new Error('invalid attest time');
  if (!HEX32.test(p.noncePoint)) throw new Error('invalid nonce point');
  const end = h1 === 24 ? nextDay(p.date) + 'T00:00:00Z' : `${p.date}T${pad(h1)}:00:00Z`;
  const content: AnnouncementContent = {
    v: 1,
    eventId,
    site: p.site,
    window: { start: `${p.date}T${pad(h0)}:00:00Z`, end },
    outcomes: [...OUTCOMES],
    rule: p.rule,
    oraclePubkey: getPublicKey(p.secret),
    noncePoint: p.noncePoint,
    attestAt: `${p.date}T${attestTime}:00Z`,
  };
  validateAnnouncementContent(content);
  const name = p.siteName ?? p.site;
  const tags: string[][] = [
    ['t', p.replayRunId === undefined ? TAG_LIVE : TAG_REPLAY],
    ['site', p.site],
    ['ndox-event', eventId],
    ['title', `Ndox · ${name} · ${p.date}`.slice(0, 100)],
    [
      'description',
      `Sea state at ${name} on ${p.date} between ${pad(h0)}:00 and ${pad(h1)}:00 UTC: ` +
        `"danger" if every model's maximum ${p.rule.variable} reaches ${p.rule.thresholdM} m ` +
        `(${p.rule.models.join(', ')}), "indisponible" if data is missing, otherwise "calme".`,
    ],
  ];
  if (p.relays && p.relays.length > 0) tags.push(['relays', ...p.relays]);
  const event = finalizeEvent(
    { kind: KIND_ANNOUNCEMENT, created_at: p.createdAt, tags, content: JSON.stringify(content) },
    p.secret,
  );
  return { event, content };
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface BuildAttestationParams {
  secret: string;
  announcement: NostrEvent;
  /** The secret nonce committed in the announcement. */
  nonceK: string;
  outcome: string;
  data: AttestationData;
  createdAt: number;
}

export function buildAttestation(p: BuildAttestationParams): {
  event: NostrEvent;
  content: AttestationContent;
} {
  const ann = parseAnnouncement(p.announcement);
  if (!ann.content.outcomes.includes(p.outcome)) throw new Error('outcome was not announced');
  if (getPublicKey(p.secret) !== ann.content.oraclePubkey) {
    throw new Error('secret does not match the announced oracle');
  }
  const a = attest(p.secret, p.nonceK, p.outcome);
  if (a.noncePoint !== ann.content.noncePoint) {
    throw new Error('nonce does not match the announced nonce point');
  }
  const content: AttestationContent = {
    v: 1,
    eventId: ann.content.eventId,
    outcome: p.outcome,
    noncePoint: a.noncePoint,
    s: a.s,
    data: p.data,
  };
  validateAttestationContent(content);
  const replay = isReplayEvent(p.announcement);
  const tags: string[][] = [
    ['e', p.announcement.id],
    ['t', replay ? TAG_REPLAY : TAG_LIVE],
    ['site', ann.content.site],
    ['ndox-event', ann.content.eventId],
  ];
  const event = finalizeEvent(
    { kind: KIND_ATTESTATION, created_at: p.createdAt, tags, content: JSON.stringify(content) },
    p.secret,
  );
  return { event, content };
}

// ---------------------------------------------------------------------------
// Parsers (structure only; signatures are checked by verifyEvent / verifyAttestationEvent)

class ParseError extends Error {}

function fail(msg: string): never {
  throw new ParseError(msg);
}

function obj(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${name} must be an object`);
  return v as Record<string, unknown>;
}

function str(v: unknown, name: string, re?: RegExp): string {
  if (typeof v !== 'string' || (re && !re.test(v))) fail(`invalid ${name}`);
  return v;
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`invalid ${name}`);
  return v;
}

function validateAnnouncementContent(c: unknown): asserts c is AnnouncementContent {
  const o = obj(c, 'content');
  if (o.v !== 1) fail('unsupported version');
  str(o.eventId, 'eventId', /^ndox(-replay)?:[a-z0-9-]+:\d{4}-\d{2}-\d{2}(:[a-z0-9-]+)?$/);
  str(o.site, 'site', SLUG);
  const w = obj(o.window, 'window');
  const start = str(w.start, 'window.start', ISO_UTC);
  const end = str(w.end, 'window.end', ISO_UTC);
  if (Date.parse(start) >= Date.parse(end)) fail('window must be non-empty');
  if (!Array.isArray(o.outcomes) || o.outcomes.length < 2) fail('invalid outcomes');
  o.outcomes.forEach((x, i) => str(x, `outcomes[${i}]`));
  if (new Set(o.outcomes).size !== o.outcomes.length) fail('duplicate outcomes');
  const r = obj(o.rule, 'rule');
  if (r.variable !== 'wave_height' && r.variable !== 'swell_wave_height') fail('invalid rule.variable');
  if (num(r.thresholdM, 'rule.thresholdM') <= 0) fail('invalid rule.thresholdM');
  if (!Array.isArray(r.models) || r.models.length < 1) fail('invalid rule.models');
  r.models.forEach((m, i) => str(m, `rule.models[${i}]`, /^[a-z0-9_]{1,40}$/));
  const mvh = num(r.minValidHours, 'rule.minValidHours');
  if (!Number.isInteger(mvh) || mvh < 1) fail('invalid rule.minValidHours');
  str(r.logic, 'rule.logic');
  str(o.oraclePubkey, 'oraclePubkey', HEX32);
  str(o.noncePoint, 'noncePoint', HEX32);
  str(o.attestAt, 'attestAt', ISO_UTC);
}

function validateAttestationContent(c: unknown): asserts c is AttestationContent {
  const o = obj(c, 'content');
  if (o.v !== 1) fail('unsupported version');
  str(o.eventId, 'eventId');
  str(o.outcome, 'outcome');
  str(o.noncePoint, 'noncePoint', HEX32);
  str(o.s, 's', HEX32);
  const d = obj(o.data, 'data');
  str(d.fetchedAt, 'data.fetchedAt', ISO_UTC);
  if (!Array.isArray(d.models)) fail('invalid data.models');
  d.models.forEach((m: unknown, i: number) => {
    const mo = obj(m, `data.models[${i}]`);
    str(mo.id, 'model id');
    if (mo.windowMaxM !== null) num(mo.windowMaxM, 'windowMaxM');
    const vh = num(mo.validHours, 'validHours');
    if (!Number.isInteger(vh) || vh < 0) fail('invalid validHours');
    str(mo.url, 'model url');
    str(mo.sha256, 'model sha256', HEX32);
  });
}

function parseContent(e: unknown, kind: number): { event: NostrEvent; json: unknown } {
  if (!isEventShape(e)) fail('not a nostr event');
  if (e.kind !== kind) fail(`expected kind ${kind}`);
  let json: unknown;
  try {
    json = JSON.parse(e.content);
  } catch {
    fail('content is not JSON');
  }
  return { event: e, json };
}

export function parseAnnouncement(e: unknown): { event: NostrEvent; content: AnnouncementContent } {
  const { event, json } = parseContent(e, KIND_ANNOUNCEMENT);
  validateAnnouncementContent(json);
  return { event, content: json };
}

export function parseAttestation(e: unknown): { event: NostrEvent; content: AttestationContent } {
  const { event, json } = parseContent(e, KIND_ATTESTATION);
  validateAttestationContent(json);
  return { event, content: json };
}

// ---------------------------------------------------------------------------
// Verification report — the same code runs in the payout engine and in the browser.

export type CheckId =
  | 'announcement_signature'
  | 'attestation_signature'
  | 'known_oracle'
  | 'same_oracle'
  | 'linked'
  | 'nonce_committed_before_window'
  | 'nonce_matches'
  | 'outcome_announced'
  | 'oracle_signature';

export interface Check {
  id: CheckId;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: Check[];
  outcome?: string;
  announcement?: AnnouncementContent;
  attestation?: AttestationContent;
  error?: string;
}

export interface VerifyOptions {
  /** If set, the announcement must be signed by this oracle key (the payout engine always sets it). */
  expectedOraclePubkey?: string;
}

export function verifyAttestationEvent(
  announcementEvent: NostrEvent,
  attestationEvent: NostrEvent,
  opts: VerifyOptions = {},
): VerificationReport {
  let ann: AnnouncementContent;
  let att: AttestationContent;
  try {
    ann = parseAnnouncement(announcementEvent).content;
    att = parseAttestation(attestationEvent).content;
  } catch (err) {
    return { ok: false, checks: [], error: err instanceof Error ? err.message : 'parse error' };
  }
  const checks: Check[] = [];
  const add = (id: CheckId, ok: boolean, detail?: string) =>
    checks.push(detail === undefined ? { id, ok } : { id, ok, detail });

  add('announcement_signature', verifyEvent(announcementEvent));
  add('attestation_signature', verifyEvent(attestationEvent));
  if (opts.expectedOraclePubkey !== undefined) {
    add('known_oracle', announcementEvent.pubkey === opts.expectedOraclePubkey);
  } else {
    add('known_oracle', true, 'no expected key supplied');
  }
  add(
    'same_oracle',
    announcementEvent.pubkey === ann.oraclePubkey && attestationEvent.pubkey === ann.oraclePubkey,
  );
  add('linked', getTag(attestationEvent, 'e') === announcementEvent.id && att.eventId === ann.eventId);
  const committedAt = announcementEvent.created_at;
  const windowStart = Date.parse(ann.window.start) / 1000;
  add(
    'nonce_committed_before_window',
    committedAt < windowStart && committedAt <= attestationEvent.created_at,
    `announced ${new Date(committedAt * 1000).toISOString()}, window opens ${ann.window.start}`,
  );
  add('nonce_matches', att.noncePoint === ann.noncePoint);
  add('outcome_announced', ann.outcomes.includes(att.outcome));
  const sigOk =
    verifyOutcomeSignature(ann.oraclePubkey, att.noncePoint, att.outcome, att.s) &&
    verifyAttestation(ann, att).ok;
  add('oracle_signature', sigOk);

  return {
    ok: checks.every((c) => c.ok),
    checks,
    outcome: att.outcome,
    announcement: ann,
    attestation: att,
  };
}
