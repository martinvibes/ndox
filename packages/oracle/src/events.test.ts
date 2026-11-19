import { verifyEvent as ntVerifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { attest, generateNonce, generateSecretKey, getPublicKey } from './crypto.js';
import {
  buildAnnouncement,
  buildAttestation,
  eventIdFor,
  finalizeEvent,
  isReplayEvent,
  KIND_ANNOUNCEMENT,
  KIND_ATTESTATION,
  type NostrEvent,
  parseAnnouncement,
  parseAttestation,
  verifyAttestationEvent,
  verifyEvent,
} from './events.js';

const RULE = {
  variable: 'wave_height' as const,
  thresholdM: 2.5,
  models: ['ecmwf_wam', 'ncep_gfswave025'],
  minValidHours: 10,
  logic: "danger if both models' window max >= threshold",
};

const DATA = {
  fetchedAt: '2026-02-27T05:00:12Z',
  models: [
    { id: 'ecmwf_wam', windowMaxM: 2.86, validHours: 12, url: 'https://x/a', sha256: 'aa'.repeat(32) },
    { id: 'ncep_gfswave025', windowMaxM: 2.62, validHours: 12, url: 'https://x/b', sha256: 'bb'.repeat(32) },
  ],
};

// 2026-02-26T20:00:00Z
const ANNOUNCE_AT = Date.UTC(2026, 1, 26, 20) / 1000;
const ATTEST_AT = Date.UTC(2026, 1, 27, 5, 15) / 1000;

function setup(opts: { replayRunId?: string; createdAt?: number } = {}) {
  const secret = generateSecretKey();
  const nonce = generateNonce();
  const ann = buildAnnouncement({
    secret,
    site: 'kayar',
    date: '2026-02-27',
    noncePoint: nonce.noncePoint,
    rule: RULE,
    createdAt: opts.createdAt ?? ANNOUNCE_AT,
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    replayRunId: opts.replayRunId,
  });
  return { secret, nonce, ann };
}

describe('nostr event primitives', () => {
  it('signs events that nostr-tools accepts', () => {
    const secret = generateSecretKey();
    const ev = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [['t', 'ndox']], content: 'Salam' }, secret);
    expect(ev.pubkey).toBe(getPublicKey(secret));
    expect(verifyEvent(ev)).toBe(true);
    expect(ntVerifyEvent({ ...ev })).toBe(true);
  });

  it('detects tampering', () => {
    const secret = generateSecretKey();
    const ev = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: 'a' }, secret);
    expect(verifyEvent({ ...ev, content: 'b' })).toBe(false);
    expect(verifyEvent({ ...ev, created_at: ev.created_at + 1 })).toBe(false);
    expect(verifyEvent({ ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === 'a' ? 'b' : 'a') })).toBe(false);
  });
});

describe('announcement (kind 88)', () => {
  it('has the documented content, tags and kind', () => {
    const { secret, nonce, ann } = setup();
    expect(ann.event.kind).toBe(KIND_ANNOUNCEMENT);
    expect(ann.content).toEqual({
      v: 1,
      eventId: 'ndox:kayar:2026-02-27',
      site: 'kayar',
      window: { start: '2026-02-27T06:00:00Z', end: '2026-02-27T18:00:00Z' },
      outcomes: ['calme', 'danger', 'indisponible'],
      rule: RULE,
      oraclePubkey: getPublicKey(secret),
      noncePoint: nonce.noncePoint,
      attestAt: '2026-02-27T05:15:00Z',
    });
    const tags = ann.event.tags;
    expect(tags).toContainEqual(['t', 'ndox']);
    expect(tags).toContainEqual(['site', 'kayar']);
    expect(tags).toContainEqual(['ndox-event', 'ndox:kayar:2026-02-27']);
    expect(tags).toContainEqual(['relays', 'wss://relay.damus.io', 'wss://nos.lol']);
    expect(tags.find((t) => t[0] === 'title')?.[1]).toMatch(/Kayar|kayar/);
    expect(ntVerifyEvent({ ...ann.event })).toBe(true);
  });

  it('round-trips through JSON serialisation', () => {
    const { ann } = setup();
    const wire = JSON.parse(JSON.stringify(ann.event)) as unknown;
    const parsed = parseAnnouncement(wire);
    expect(parsed.content).toEqual(ann.content);
    expect(parsed.event).toEqual(ann.event);
  });

  it('rejects malformed content', () => {
    const { secret } = setup();
    const bad = finalizeEvent({ kind: 88, created_at: ANNOUNCE_AT, tags: [], content: '{"v":2}' }, secret);
    expect(() => parseAnnouncement(bad)).toThrow();
    const notJson = finalizeEvent({ kind: 88, created_at: ANNOUNCE_AT, tags: [], content: 'hello' }, secret);
    expect(() => parseAnnouncement(notJson)).toThrow();
    expect(() => parseAnnouncement({ kind: 88 })).toThrow();
  });

  it('marks replays with a distinct tag and event id', () => {
    const { ann } = setup({ replayRunId: 'r1' });
    expect(ann.content.eventId).toBe('ndox-replay:kayar:2026-02-27:r1');
    expect(ann.event.tags).toContainEqual(['t', 'ndox-replay']);
    expect(ann.event.tags).not.toContainEqual(['t', 'ndox']);
    expect(isReplayEvent(ann.event)).toBe(true);
    expect(isReplayEvent(setup().ann.event)).toBe(false);
  });

  it('builds event ids', () => {
    expect(eventIdFor('joal', '2026-11-20')).toBe('ndox:joal:2026-11-20');
    expect(eventIdFor('joal', '2026-11-20', 'abc')).toBe('ndox-replay:joal:2026-11-20:abc');
    expect(() => eventIdFor('joal', '20-11-2026')).toThrow();
  });
});

describe('attestation (kind 89)', () => {
  it('links to the announcement and round-trips', () => {
    const { secret, nonce, ann } = setup();
    const att = buildAttestation({
      secret,
      announcement: ann.event,
      nonceK: nonce.k,
      outcome: 'danger',
      data: DATA,
      createdAt: ATTEST_AT,
    });
    expect(att.event.kind).toBe(KIND_ATTESTATION);
    expect(att.event.tags).toContainEqual(['e', ann.event.id]);
    expect(att.event.tags).toContainEqual(['t', 'ndox']);
    expect(att.event.tags).toContainEqual(['site', 'kayar']);
    expect(att.event.tags).toContainEqual(['ndox-event', 'ndox:kayar:2026-02-27']);
    expect(att.content.noncePoint).toBe(nonce.noncePoint);
    expect(att.content.data).toEqual(DATA);
    const parsed = parseAttestation(JSON.parse(JSON.stringify(att.event)) as unknown);
    expect(parsed.content).toEqual(att.content);
    expect(ntVerifyEvent({ ...att.event })).toBe(true);
  });

  it('refuses to attest with a nonce that was not announced', () => {
    const { secret, ann } = setup();
    expect(() =>
      buildAttestation({
        secret,
        announcement: ann.event,
        nonceK: generateNonce().k,
        outcome: 'danger',
        data: DATA,
        createdAt: ATTEST_AT,
      }),
    ).toThrow(/nonce/);
  });

  it('refuses outcomes that were not announced', () => {
    const { secret, nonce, ann } = setup();
    expect(() =>
      buildAttestation({ secret, announcement: ann.event, nonceK: nonce.k, outcome: 'maybe', data: DATA, createdAt: ATTEST_AT }),
    ).toThrow(/outcome/);
  });
});

describe('verifyAttestationEvent', () => {
  function pair() {
    const s = setup();
    const att = buildAttestation({
      secret: s.secret,
      announcement: s.ann.event,
      nonceK: s.nonce.k,
      outcome: 'danger',
      data: DATA,
      createdAt: ATTEST_AT,
    });
    return { ...s, att };
  }

  it('passes every check for an honest pair', () => {
    const { ann, att, secret } = pair();
    const report = verifyAttestationEvent(ann.event, att.event, { expectedOraclePubkey: getPublicKey(secret) });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      'announcement_signature',
      'attestation_signature',
      'known_oracle',
      'same_oracle',
      'linked',
      'nonce_committed_before_window',
      'nonce_matches',
      'outcome_announced',
      'oracle_signature',
    ]);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.outcome).toBe('danger');
  });

  it('fails when the oracle is not the expected one', () => {
    const { ann, att } = pair();
    const report = verifyAttestationEvent(ann.event, att.event, { expectedOraclePubkey: getPublicKey(generateSecretKey()) });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'known_oracle')?.ok).toBe(false);
  });

  it('fails when the announcement was created after the window opened', () => {
    const s = setup({ createdAt: Date.UTC(2026, 1, 27, 7) / 1000 });
    const att = buildAttestation({ secret: s.secret, announcement: s.ann.event, nonceK: s.nonce.k, outcome: 'calme', data: DATA, createdAt: ATTEST_AT });
    const report = verifyAttestationEvent(s.ann.event, att.event);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'nonce_committed_before_window')?.ok).toBe(false);
  });

  it('fails when the attestation event was tampered with (outcome swapped)', () => {
    const { ann, att } = pair();
    const content = { ...att.content, outcome: 'calme' };
    const forged: NostrEvent = { ...att.event, content: JSON.stringify(content) };
    const report = verifyAttestationEvent(ann.event, forged);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'attestation_signature')?.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'oracle_signature')?.ok).toBe(false);
  });

  it('fails when the oracle re-signs the Nostr event with a different nonce', () => {
    const { ann, secret, att } = pair();
    const other = generateNonce();
    const a = attest(secret, other.k, 'calme');
    const content = { ...att.content, outcome: 'calme', noncePoint: a.noncePoint, s: a.s };
    const resigned = finalizeEvent({ kind: 89, created_at: ATTEST_AT, tags: att.event.tags, content: JSON.stringify(content) }, secret);
    const report = verifyAttestationEvent(ann.event, resigned);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'attestation_signature')?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'nonce_matches')?.ok).toBe(false);
  });

  it('fails when the attestation points at another announcement', () => {
    const a = pair();
    const b = pair();
    const report = verifyAttestationEvent(a.ann.event, b.att.event);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'linked')?.ok).toBe(false);
  });

  it('returns a failed report instead of throwing on garbage', () => {
    const report = verifyAttestationEvent({ kind: 88 } as unknown as NostrEvent, {} as NostrEvent);
    expect(report.ok).toBe(false);
  });
});
