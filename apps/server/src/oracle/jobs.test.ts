import {
  noncePointFromNonce,
  parseAttestation,
  verifyAttestationEvent,
  verifyEvent,
  getTag,
  type NostrEvent,
} from '@ndox/oracle';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { announcements, attestations, forecasts } from '../db/schema.js';
import { open } from '../lib/box.js';
import { MemoryPublisher } from '../nostr/publisher.js';
import { makeCtx, memoryDb, settableClock, StubSource } from '../test/helpers.js';
import { sha256Hex } from '../wave/source.js';
import {
  announce,
  attest,
  fetchForecasts,
  getAnnouncement,
  getAttestation,
  JobError,
  publishPending,
} from './jobs.js';

const D = '2026-02-27';
const EVE = '2026-02-26T20:00:00Z';
const FETCH = '2026-02-27T05:00:00Z';
const ATTEST = '2026-02-27T05:15:00Z';

async function expectJobError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(JobError);
  await p.catch((e: JobError) => expect(e.code).toBe(code));
}

function setup(
  heights: Record<string, number | Error> = { ecmwf_wam: 2.86, ncep_gfswave025: 2.62 },
) {
  const db = memoryDb();
  const t = settableClock(EVE);
  const source = StubSource.constant(heights);
  const ctx = makeCtx(db, { clock: t.clock, source });
  return { db, t, ctx, source };
}

async function runDay(s: ReturnType<typeof setup>) {
  await announce(s.ctx, 'kayar', D);
  s.t.set(FETCH);
  await fetchForecasts(s.ctx, 'kayar', D);
  s.t.set(ATTEST);
  return attest(s.ctx, 'kayar', D);
}

describe('announce', () => {
  it('creates one signed announcement with a sealed nonce, and is idempotent', async () => {
    const s = setup();
    const a1 = await announce(s.ctx, 'kayar', D);
    const a2 = await announce(s.ctx, 'kayar', D);
    expect(a1.created).toBe(true);
    expect(a2.created).toBe(false);
    expect(a2.nostrId).toBe(a1.nostrId);
    expect(a1.eventId).toBe('ndox:kayar:2026-02-27');
    expect(a1.published).toBe(false); // dry run

    const row = getAnnouncement(s.db, a1.eventId);
    expect(row).toBeDefined();
    const event = JSON.parse(row?.eventJson ?? '') as NostrEvent;
    expect(verifyEvent(event)).toBe(true);
    expect(getTag(event, 't')).toBe('ndox');
    expect(event.created_at).toBe(Date.parse(EVE) / 1000);

    // the nonce is sealed, bound to this event id, and matches the committed nonce point
    const sealed = row?.nonceEnc ?? '';
    expect(sealed.startsWith('v1.')).toBe(true);
    const k = open(s.ctx.nonceKey, sealed, a1.eventId);
    expect(sealed).not.toContain(k);
    expect(noncePointFromNonce(k)).toBe(a1.noncePoint);
    expect(() => open(s.ctx.nonceKey, sealed, 'ndox:kayar:2026-02-28')).toThrow();
  });

  it('refuses to commit at or after the attestation time', async () => {
    const s = setup();
    s.t.set(ATTEST);
    await expectJobError(announce(s.ctx, 'kayar', D), 'too_late');
    s.t.set('2026-02-27T05:14:59Z');
    await expect(announce(s.ctx, 'kayar', D)).resolves.toMatchObject({ created: true });
  });

  it('rejects unknown sites and invalid dates', async () => {
    const s = setup();
    await expectJobError(announce(s.ctx, 'atlantis', D), 'unknown_site');
    await expectJobError(announce(s.ctx, 'kayar', '2026-02-30'), 'invalid_date');
  });

  it('uses the site threshold from the database in the committed rule', async () => {
    const s = setup();
    await announce(s.ctx, 'joal', D);
    const row = getAnnouncement(s.db, 'ndox:joal:2026-02-27');
    const content = JSON.parse((JSON.parse(row?.eventJson ?? '') as NostrEvent).content) as {
      rule: { thresholdM: number; models: string[]; minValidHours: number };
    };
    expect(content.rule).toMatchObject({
      thresholdM: 2.5,
      models: ['ecmwf_wam', 'ncep_gfswave025'],
      minValidHours: 10,
    });
  });
});

describe('fetch + attest', () => {
  it('signs "danger" when both models reach the threshold, and the public verifier accepts it', async () => {
    const s = setup();
    const res = await runDay(s);
    expect(res).toMatchObject({
      outcome: 'danger',
      decisiveM: 2.62,
      created: true,
      published: false,
    });

    const ann = JSON.parse(getAnnouncement(s.db, res.eventId)?.eventJson ?? '') as NostrEvent;
    const att = JSON.parse(getAttestation(s.db, res.eventId)?.eventJson ?? '') as NostrEvent;
    const report = verifyAttestationEvent(ann, att, { expectedOraclePubkey: ann.pubkey });
    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('danger');

    // published hashes match the stored raw bodies byte for byte
    const content = parseAttestation(att).content;
    const rows = s.db.select().from(forecasts).where(eq(forecasts.eventId, res.eventId)).all();
    for (const m of content.data.models) {
      const r = rows.find((x) => x.model === m.id);
      expect(sha256Hex(r?.body ?? '')).toBe(m.sha256);
    }
    expect(content.data.models.map((m) => m.windowMaxM)).toEqual([2.86, 2.62]);
    expect(content.data.fetchedAt).toBe('2026-02-27T05:00:07Z');
  });

  it('deletes the nonce in the same step and never signs twice', async () => {
    const s = setup();
    const first = await runDay(s);
    expect(getAnnouncement(s.db, first.eventId)?.nonceEnc).toBeNull();
    const again = await attest(s.ctx, 'kayar', D);
    expect(again.created).toBe(false);
    expect(again.nostrId).toBe(first.nostrId);
    expect(s.db.select().from(attestations).all()).toHaveLength(1);
  });

  it('is safe under concurrent attest calls', async () => {
    const s = setup();
    await announce(s.ctx, 'kayar', D);
    s.t.set(FETCH);
    await fetchForecasts(s.ctx, 'kayar', D);
    s.t.set(ATTEST);
    const [a, b] = await Promise.all([attest(s.ctx, 'kayar', D), attest(s.ctx, 'kayar', D)]);
    expect(a.nostrId).toBe(b.nostrId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('freezes the data once attested (fetch is skipped, stored bodies unchanged)', async () => {
    const s = setup();
    const res = await runDay(s);
    const before = s.db.select().from(forecasts).all();
    const calls = s.source.calls.length;
    const again = await fetchForecasts(s.ctx, 'kayar', D);
    expect(again).toMatchObject({ status: 'skipped', reason: 'already_attested' });
    expect(s.source.calls.length).toBe(calls);
    expect(s.db.select().from(forecasts).all()).toEqual(before);
    expect(res.outcome).toBe('danger');
  });

  it('never overwrites data when the attestation lands while a fetch is in flight', async () => {
    const s = setup();
    await announce(s.ctx, 'kayar', D);
    s.t.set(FETCH);
    await fetchForecasts(s.ctx, 'kayar', D);
    s.t.set(ATTEST);
    const before = s.db.select().from(forecasts).all();
    const calm = StubSource.constant({ ecmwf_wam: 0.5, ncep_gfswave025: 0.5 });
    const racing = new StubSource(() => new Error('unused'));
    racing.get = async (q) => {
      await attest(s.ctx, 'kayar', D); // another worker attests meanwhile
      return calm.get(q);
    };
    const res = await fetchForecasts({ ...s.ctx, source: racing }, 'kayar', D);
    expect(res).toMatchObject({ status: 'skipped', reason: 'already_attested' });
    expect(s.db.select().from(forecasts).all()).toEqual(before);
    expect(getAttestation(s.db, res.eventId)?.outcome).toBe('danger');
  });

  it('signs "calme" when only one model reaches the threshold', async () => {
    const res = await runDay(setup({ ecmwf_wam: 2.9, ncep_gfswave025: 2.1 }));
    expect(res).toMatchObject({ outcome: 'calme', decisiveM: 2.1 });
  });

  it('signs "indisponible" when a model cannot be fetched', async () => {
    const s = setup({ ecmwf_wam: 3.1, ncep_gfswave025: new Error('HTTP 503') });
    const res = await runDay(s);
    expect(res).toMatchObject({ outcome: 'indisponible', decisiveM: null });
    const att = parseAttestation(JSON.parse(getAttestation(s.db, res.eventId)?.eventJson ?? ''));
    expect(att.content.data.models.map((m) => m.id)).toEqual(['ecmwf_wam']);
    const failed = s.db
      .select()
      .from(forecasts)
      .where(eq(forecasts.model, 'ncep_gfswave025'))
      .get();
    expect(failed).toMatchObject({ status: 'error', body: null, sha256: null, error: 'HTTP 503' });
  });

  it('keeps an earlier good response when a retry fails', async () => {
    const heights: Record<string, number | Error> = { ecmwf_wam: 2.7, ncep_gfswave025: 2.6 };
    const s = setup(heights);
    await announce(s.ctx, 'kayar', D);
    s.t.set(FETCH);
    await fetchForecasts(s.ctx, 'kayar', D);
    heights.ecmwf_wam = new Error('timeout');
    heights.ncep_gfswave025 = new Error('timeout');
    const retry = await fetchForecasts(s.ctx, 'kayar', D);
    expect(retry.models.every((m) => !m.ok)).toBe(true);
    s.t.set(ATTEST);
    const res = await attest(s.ctx, 'kayar', D);
    expect(res).toMatchObject({ outcome: 'danger', decisiveM: 2.6 });
  });

  it('enforces the attestation time and the window', async () => {
    const s = setup();
    await announce(s.ctx, 'kayar', D);
    s.t.set(FETCH);
    await fetchForecasts(s.ctx, 'kayar', D);
    await expectJobError(attest(s.ctx, 'kayar', D), 'too_early');
    s.t.set('2026-02-27T18:00:00Z');
    await expectJobError(attest(s.ctx, 'kayar', D), 'window_closed');
  });

  it('requires an announcement before fetching or attesting', async () => {
    const s = setup();
    s.t.set(ATTEST);
    await expectJobError(fetchForecasts(s.ctx, 'kayar', D), 'no_announcement');
    await expectJobError(attest(s.ctx, 'kayar', D), 'no_announcement');
  });

  it('refuses to sign when the nonce is gone but no attestation exists', async () => {
    const s = setup();
    await announce(s.ctx, 'kayar', D);
    s.db.update(announcements).set({ nonceEnc: null }).run();
    s.t.set(ATTEST);
    await expectJobError(attest(s.ctx, 'kayar', D), 'nonce_missing');
    expect(s.db.select().from(attestations).all()).toHaveLength(0);
  });
});

describe('publishing', () => {
  it('publishes the announcement and then the attestation', async () => {
    const s = setup();
    const pub = new MemoryPublisher();
    s.ctx.publisher = pub;
    const res = await runDay(s);
    expect(res.published).toBe(true);
    expect(pub.events.map((e) => e.kind)).toEqual([88, 89]);
    expect(getAttestation(s.db, res.eventId)?.publishedAt).toMatch(/Z$/);
  });

  it('retries unpublished events later', async () => {
    const s = setup();
    s.ctx.publisher = new MemoryPublisher(false);
    const res = await runDay(s);
    expect(res.published).toBe(false);
    expect(getAnnouncement(s.db, res.eventId)?.publishedAt).toBeNull();

    // too soon: not retried
    const ok = new MemoryPublisher();
    s.ctx.publisher = ok;
    expect(await publishPending(s.ctx)).toBe(0);

    // after the retry delay
    s.db
      .update(announcements)
      .set({ publishResult: { at: '2026-01-01T00:00:00Z' } })
      .run();
    s.db.update(attestations).set({ publishResult: null }).run();
    expect(await publishPending(s.ctx)).toBe(2);
    expect(ok.events.map((e) => e.kind)).toEqual([88, 89]);
    expect(await publishPending(s.ctx)).toBe(0);
  });
});
