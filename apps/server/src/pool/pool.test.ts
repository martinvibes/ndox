import { getPublicKey, verifyEvent, type NostrEvent } from '@ndox/oracle';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { crews, deposits, policies } from '../db/schema.js';
import { deriveKey } from '../lib/box.js';
import { silentLog } from '../lib/log.js';
import { PriceService } from '../money/price.js';
import { MemoryPublisher } from '../nostr/publisher.js';
import { memoryDb, settableClock } from '../test/helpers.js';
import { FakeWallet } from '../wallet/fake.js';
import { crewSecrets, enrolCrew, holderCommitment, listCrews, STATUS_CODE_RE } from './crews.js';
import { createDeposit, pollDeposits, refreshDeposit, type MoneyCtx } from './deposits.js';
import {
  applyPremium,
  createPolicy,
  eligiblePolicies,
  expirePolicies,
  policyStatusAt,
  publishPendingPolicies,
} from './policies.js';
import { Pricing } from './pricing.js';
import { getPolicySettings, updatePolicySettings, type PolicySettings } from './settings.js';
import { DEFAULT_PATHS } from '../paths.js';

const PII = deriveKey('3d'.repeat(32), 'pii');
const POOL_SECRET = '4c'.repeat(32);
const DEFAULTS: PolicySettings = {
  payoutFcfa: 2000,
  waitingHours: 72,
  premiumLoading: 0.25,
  dailyPayoutCapSats: 20_000,
  reserveFloorSats: 0,
};
const pricing = Pricing.load(DEFAULT_PATHS.seedDir);

function setup(start = '2026-11-19T12:00:00Z') {
  const db = memoryDb();
  const t = settableClock(start);
  const wallet = new FakeWallet({ db, seed: '5a'.repeat(32), account: 'pool', clock: t.clock });
  const prices = new PriceService({
    db,
    clock: t.clock,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ time: 1_795_095_305, EUR: 57_941 }))) as typeof fetch,
  });
  const publisher = new MemoryPublisher();
  const ctx: MoneyCtx = {
    db,
    wallet,
    prices,
    clock: t.clock,
    poolSecret: POOL_SECRET,
    publisher,
    relays: ['wss://relay.example'],
    pricing,
    settings: () => getPolicySettings(db, DEFAULTS),
    log: silentLog,
  };
  return { db, t, wallet, ctx, publisher };
}

const crewInput = {
  site: 'kayar',
  lnAddress: 'k01@demo.ndox.invalid',
  phone: '+221770000001',
  demo: true,
};

describe('settings and pricing', () => {
  it('uses env defaults until the council changes them', () => {
    const db = memoryDb();
    expect(getPolicySettings(db, DEFAULTS)).toEqual(DEFAULTS);
    updatePolicySettings(db, DEFAULTS, { payoutFcfa: 1500, waitingHours: 48 });
    expect(getPolicySettings(db, DEFAULTS)).toEqual({
      ...DEFAULTS,
      payoutFcfa: 1500,
      waitingHours: 48,
    });
    expect(() => updatePolicySettings(db, DEFAULTS, { payoutFcfa: 12.5 })).toThrow();
    expect(() => updatePolicySettings(db, DEFAULTS, { premiumLoading: -1 })).toThrow();
  });

  it('prices the weekly premium from the backtest at the site threshold', () => {
    expect(pricing.weeklyPremiumFcfa('kayar', 2.5, DEFAULTS)).toBe(1006);
    expect(pricing.weeklyPremiumFcfa('kayar', 2.0, DEFAULTS)).toBe(4266);
    // no exact entry: the nearest lower threshold (more danger days) is the conservative basis
    expect(pricing.risk('kayar', 2.7).basisThresholdM).toBe(2.5);
    expect(pricing.weeklyPremiumFcfa('kayar', 2.5, { ...DEFAULTS, payoutFcfa: 1000 })).toBe(503);
    expect(pricing.risk('saint-louis', 2.5).worstWeekDangerDays).toBe(7);
  });
});

describe('crews', () => {
  it('enrols a crew with sealed phone and Lightning address and a public pseudonym and code', () => {
    const { db } = setup();
    const c = enrolCrew(db, PII, crewInput);
    expect(c.statusCode).toMatch(STATUS_CODE_RE);
    expect(c.statusCode.startsWith('K')).toBe(true);
    expect(c.pseudonym).toBe('Pirogue K-01');
    expect(c.lnAddressHint).toBe('•••@demo.ndox.invalid');
    expect(c.phoneHint).toBe('•• 01');
    const raw = JSON.stringify(db.select().from(crews).all());
    expect(raw).not.toContain('k01@');
    expect(raw).not.toContain('770000001');
    expect(crewSecrets(db, PII, c.id)).toEqual({
      lnAddress: 'k01@demo.ndox.invalid',
      phone: '+221770000001',
    });
    expect(enrolCrew(db, PII, { ...crewInput, lnAddress: 'k02@demo.ndox.invalid' }).pseudonym).toBe(
      'Pirogue K-02',
    );
    expect(listCrews(db, PII).map((x) => x.pseudonym)).toEqual(['Pirogue K-01', 'Pirogue K-02']);
  });

  it('rejects bad input', () => {
    const { db } = setup();
    expect(() => enrolCrew(db, PII, { ...crewInput, site: 'dakar' })).toThrow(/site/);
    expect(() => enrolCrew(db, PII, { ...crewInput, lnAddress: 'not-an-address' })).toThrow(
      /Lightning address/,
    );
    expect(() => enrolCrew(db, PII, { ...crewInput, phone: '77 000 00 01' })).toThrow(/phone/);
    enrolCrew(db, PII, { ...crewInput, pseudonym: 'Pirogue Bleue' });
    expect(() => enrolCrew(db, PII, { ...crewInput, pseudonym: 'Pirogue Bleue' })).toThrow(
      /pseudonym/,
    );
  });

  it('commits to the holder with sha256(salt || crewId)', () => {
    // python: hashlib.sha256(bytes.fromhex('00'*16) + b'c1').hexdigest()
    expect(holderCommitment('00'.repeat(16), 'c1')).toBe(
      '106594376da05166fac81a1f55f3365a225bcc4767497d4a7d497d8b57d66fdd',
    );
    expect(holderCommitment('01'.repeat(16), 'c1')).not.toBe(
      holderCommitment('00'.repeat(16), 'c1'),
    );
  });
});

describe('policies', () => {
  it('activates after the 72 h waiting period and covers [activeFrom, activeUntil)', () => {
    const { db } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const p = createPolicy(db, {
      crewId: crew.id,
      fundedBy: 'crew',
      weeks: 1,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1006,
    });
    expect(p).toMatchObject({ status: 'pending', premiumFcfa: 1006, thresholdCm: 250 });
    expect(policyStatusAt(p, new Date('2026-11-19T12:00:00Z'))).toBe('awaiting_premium');

    const paid = applyPremium(db, p.id, new Date('2026-11-19T12:00:00Z'), 72);
    expect(paid).toMatchObject({
      status: 'active',
      paidAt: '2026-11-19T12:00:00Z',
      activeFrom: '2026-11-22T12:00:00Z',
      activeUntil: '2026-11-29T12:00:00Z',
    });
    const at = (iso: string) => eligiblePolicies(db, 'kayar', new Date(iso)).map((x) => x.id);
    expect(at('2026-11-22T11:59:59Z')).toEqual([]); // still waiting
    expect(policyStatusAt(paid, new Date('2026-11-22T11:59:59Z'))).toBe('waiting');
    expect(at('2026-11-22T12:00:00Z')).toEqual([p.id]);
    expect(at('2026-11-29T11:59:59Z')).toEqual([p.id]);
    expect(at('2026-11-29T12:00:00Z')).toEqual([]);
    expect(eligiblePolicies(db, 'joal', new Date('2026-11-23T06:00:00Z'))).toEqual([]);
  });

  it('renews without a new waiting period while covered, and with one after a lapse', () => {
    const { db } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const p = createPolicy(db, {
      crewId: crew.id,
      fundedBy: 'clpa',
      weeks: 2,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1006,
    });
    expect(p.premiumFcfa).toBe(2012);
    applyPremium(db, p.id, new Date('2026-11-01T00:00:00Z'), 72);
    const renewed = applyPremium(db, p.id, new Date('2026-11-10T00:00:00Z'), 72);
    expect(renewed).toMatchObject({
      activeFrom: '2026-11-04T00:00:00Z',
      activeUntil: '2026-12-02T00:00:00Z',
    });

    expect(expirePolicies(db, new Date('2026-12-02T00:00:00Z'))).toBe(1);
    const lapsed = applyPremium(db, p.id, new Date('2026-12-05T00:00:00Z'), 72);
    expect(lapsed).toMatchObject({
      status: 'active',
      activeFrom: '2026-12-08T00:00:00Z',
      activeUntil: '2026-12-22T00:00:00Z',
    });
  });

  it('ignores inactive crews', () => {
    const { db } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const p = createPolicy(db, {
      crewId: crew.id,
      fundedBy: 'crew',
      weeks: 1,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1006,
    });
    applyPremium(db, p.id, new Date('2026-11-01T00:00:00Z'), 0);
    db.update(crews).set({ active: false }).where(eq(crews.id, crew.id)).run();
    expect(eligiblePolicies(db, 'kayar', new Date('2026-11-02T00:00:00Z'))).toEqual([]);
  });

  it('publishes a pool-signed kind 30078 policy event without personal data', async () => {
    const { db, ctx, publisher } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const p = createPolicy(db, {
      crewId: crew.id,
      fundedBy: 'sponsor',
      weeks: 1,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1006,
    });
    applyPremium(db, p.id, new Date('2026-11-19T12:00:00Z'), 72);
    expect(await publishPendingPolicies(ctx)).toBe(1);
    expect(await publishPendingPolicies(ctx)).toBe(0);

    const ev = publisher.events[0] as NostrEvent;
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(30078);
    expect(ev.pubkey).toBe(getPublicKey(POOL_SECRET));
    expect(ev.tags).toContainEqual(['d', `ndox:policy:${p.id}`]);
    expect(JSON.parse(ev.content)).toEqual({
      v: 1,
      policyId: p.id,
      site: 'kayar',
      payoutFcfa: 2000,
      thresholdM: 2.5,
      activeFrom: '2026-11-22T12:00:00Z',
      activeUntil: '2026-11-29T12:00:00Z',
      holderCommitment: holderCommitment(
        db.select().from(crews).where(eq(crews.id, crew.id)).get()!.holderSalt,
        crew.id,
      ),
      fundedBy: 'sponsor',
      demo: true,
    });
    const text = JSON.stringify(ev);
    for (const pii of ['k01@', '770000001', crew.id, crew.statusCode, crew.pseudonym])
      expect(text).not.toContain(pii);
    expect(db.select().from(policies).get()?.publishedAt).toBe('2026-11-19T12:00:00Z');
  });
});

describe('deposits', () => {
  it('turns a paid premium invoice into active cover, exactly once', async () => {
    const { db, ctx, wallet } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const p = createPolicy(db, {
      crewId: crew.id,
      fundedBy: 'crew',
      weeks: 1,
      payoutFcfa: 2000,
      premiumWeeklyFcfa: 1006,
    });
    const d = await createDeposit(ctx, { kind: 'premium', policyId: p.id });
    expect(d).toMatchObject({
      kind: 'premium',
      status: 'pending',
      amountFcfa: 1006,
      amountSat: 2647, // ceil(1006 × 1e8 / 38006805)
      xofPerBtc: 38_006_805,
      wallet: 'fake',
    });
    expect(d.invoice?.startsWith('lnbcrt')).toBe(true);

    expect((await refreshDeposit(ctx, d.paymentHash!))?.status).toBe('pending');
    wallet.simulatePayment(d.paymentHash!);
    expect((await refreshDeposit(ctx, d.paymentHash!))?.status).toBe('paid');
    expect((await refreshDeposit(ctx, d.paymentHash!))?.status).toBe('paid');
    const pol = db.select().from(policies).where(eq(policies.id, p.id)).get();
    expect(pol).toMatchObject({ status: 'active', activeUntil: '2026-11-29T12:00:00Z' });
    expect(await wallet.getBalanceSat()).toBe(2647);
  });

  it('polls pending deposits and expires the unpaid ones', async () => {
    const { ctx, wallet, t, db } = setup();
    const a = await createDeposit(ctx, { kind: 'levy', amountFcfa: 20_000 });
    const b = await createDeposit(ctx, { kind: 'sponsor', amountFcfa: 5000, site: 'kayar' });
    expect(a.memo).toBe('Versement caisse CLPA');
    wallet.simulatePayment(a.paymentHash!);
    expect(await pollDeposits(ctx)).toEqual({ checked: 2, paid: 1, expired: 0 });
    t.set('2026-11-19T13:00:00Z');
    expect(await pollDeposits(ctx)).toEqual({ checked: 1, paid: 0, expired: 1 });
    expect(db.select().from(deposits).where(eq(deposits.id, b.id)).get()?.status).toBe('expired');
  });

  it('turns a sponsor gift for one crew into weeks of cover (remainder stays in the pool)', async () => {
    const { db, ctx, wallet } = setup();
    const crew = enrolCrew(db, PII, crewInput);
    const d = await createDeposit(ctx, {
      kind: 'sponsor',
      amountFcfa: 5000,
      crewPseudonym: crew.pseudonym,
    });
    wallet.simulatePayment(d.paymentHash!);
    await refreshDeposit(ctx, d.paymentHash!);
    const pol = db.select().from(policies).where(eq(policies.crewId, crew.id)).all();
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ fundedBy: 'sponsor', weeks: 4, status: 'active' }); // 5000 / 1006
    expect(pol[0]?.premiumFcfa).toBe(4024);

    const small = await createDeposit(ctx, {
      kind: 'sponsor',
      amountFcfa: 500,
      crewPseudonym: crew.pseudonym,
    });
    wallet.simulatePayment(small.paymentHash!);
    await refreshDeposit(ctx, small.paymentHash!);
    expect(db.select().from(policies).where(eq(policies.crewId, crew.id)).all()).toHaveLength(1);

    await expect(
      createDeposit(ctx, { kind: 'sponsor', amountFcfa: 5000, crewPseudonym: 'Inconnu' }),
    ).rejects.toThrow(/unknown crew/);
    await expect(createDeposit(ctx, { kind: 'sponsor', amountFcfa: 0 })).rejects.toThrow();
  });
});
