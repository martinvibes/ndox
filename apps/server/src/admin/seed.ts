/**
 * Demo crews (docs/BRIEF.md §4 honesty rule, §15): N crews per site, labelled Démo, covered by
 * premiums backdated by the waiting period so the cover is active now. Two set-ups:
 *  - simulated (FakeWallet, or a mainnet NWC pool): team-controlled `*.invalid` addresses and
 *    premiums paid by a simulated wallet. A mainnet wallet never pays demo policies.
 *  - test funds (NWC wallet on a test network): each crew gets a faucet test wallet (a Lightning
 *    address that really receives its payout), and the test payer pays the premiums and the levy
 *    into the pool over Lightning. Every sat involved is a test sat.
 *
 * Idempotent: tops each site up to N active demo crews, renews only lapsed demo cover, and
 * tops the simulated pool up to a target balance.
 */
import { fcfaToSat, SITES } from '@ndox/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { crews, policies } from '../db/schema.js';
import { enrolCrew } from '../pool/crews.js';
import { createDeposit, refreshDeposit, weeklyPremiumFor } from '../pool/deposits.js';
import { createPolicy } from '../pool/policies.js';
import { isoSeconds } from '../lib/time.js';
import type { Services } from '../services.js';
import { FakeWallet } from '../wallet/fake.js';

export interface SeedDemoOptions {
  perSite?: number;
  weeks?: number;
  /**
   * Top the pool up to this many FCFA with a levy (nothing if it already holds that much), so
   * re-running does not keep adding money. FakeWallet: simulated; test funds: paid by the test
   * payer. Ignored with a mainnet wallet.
   */
  poolFcfa?: number;
}

export interface SeedDemoResult {
  enrolled: number;
  covered: number;
  premiumSat: number;
  levySat: number;
  /** false: premiums and levy were real Lightning payments of test sats. */
  simulated: boolean;
}

export async function seedDemo(s: Services, o: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const perSite = o.perSite ?? 10;
  const weeks = o.weeks ?? 4;
  if (!Number.isInteger(perSite) || perSite < 1 || perSite > 50)
    throw new Error('perSite must be 1–50');
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error('weeks must be 1–52');

  // Who pays demo premiums: the test payer into the test pool (real Lightning, test sats); else a
  // simulated wallet: the pool itself in FakeWallet mode, a separate simulated account next to a
  // mainnet wallet (so the real pool's books stay real).
  const testPayer = s.money.testFunds ? (s.money.testPayer ?? null) : null;
  const wallet = testPayer
    ? s.wallet
    : s.wallet instanceof FakeWallet
      ? s.wallet
      : new FakeWallet({
          db: s.db,
          seed: s.replayPayouts.fakeSeed,
          account: 'demo-premiums',
          clock: s.clock,
        });
  const pay = async (
    ctx: typeof s.money,
    d: { paymentHash: string | null; invoice: string | null },
  ) => {
    if (testPayer) await testPayer.payInvoice(d.invoice!);
    else if (!(wallet as FakeWallet).simulatePayment(d.paymentHash!))
      throw new Error('simulated payment refused');
    const after = await refreshDeposit(ctx, d.paymentHash!);
    if (after?.status !== 'paid') throw new Error('demo deposit did not settle');
  };
  const now = s.clock();
  const settings = s.settings();
  const paidAt = new Date(now.getTime() - settings.waitingHours * 3600_000);
  const backdated = { ...s.money, wallet, publisher: null, clock: () => paidAt };

  let levySat = 0;
  if (o.poolFcfa && (testPayer || s.wallet instanceof FakeWallet)) {
    const { xofPerBtc } = await s.prices.get();
    const deficitSat = fcfaToSat(o.poolFcfa, xofPerBtc, 'ceil') - (await s.wallet.getBalanceSat());
    if (deficitSat > 0) {
      // smallest whole FCFA amount covering the deficit (integer ceil of sat × XOF/BTC ÷ 1e8)
      const amountFcfa = Math.max(100, Math.floor((deficitSat * xofPerBtc + 1e8 - 1) / 1e8));
      const d = await createDeposit(s.money, { kind: 'levy', amountFcfa });
      await pay(s.money, d);
      levySat = d.amountSat;
    }
  }

  let enrolled = 0;
  for (const site of SITES) {
    const have = s.db
      .select()
      .from(crews)
      .where(and(eq(crews.site, site.id), eq(crews.demo, true), eq(crews.active, true)))
      .all().length;
    for (let i = have; i < perSite; i++) {
      const n = String(i + 1).padStart(2, '0');
      // test funds: a faucet wallet that really receives the payout
      const lnAddress = s.faucet
        ? (await s.faucet.createWallet()).lightningAddress
        : `${site.id}-${n}@demo.ndox.invalid`;
      enrolCrew(s.db, s.piiKey, { site: site.id, lnAddress, demo: true });
      enrolled++;
    }
  }

  const demoCrews = s.db
    .select()
    .from(crews)
    .where(and(eq(crews.demo, true), eq(crews.active, true)))
    .all();
  const coveredNow = new Set(
    s.db
      .select({ crewId: policies.crewId })
      .from(policies)
      .where(
        and(
          inArray(
            policies.crewId,
            demoCrews.map((c) => c.id),
          ),
          eq(policies.status, 'active'),
          gt(policies.activeUntil, isoSeconds(now)),
        ),
      )
      .all()
      .map((r) => r.crewId),
  );

  let covered = 0;
  let premiumSat = 0;
  for (const crew of demoCrews) {
    if (coveredNow.has(crew.id)) continue;
    const policy = createPolicy(s.db, {
      crewId: crew.id,
      fundedBy: 'clpa',
      weeks,
      payoutFcfa: settings.payoutFcfa,
      premiumWeeklyFcfa: weeklyPremiumFor(s.money, s.db, crew.site),
    });
    const d = await createDeposit(backdated, { kind: 'premium', policyId: policy.id });
    await pay(backdated, d);
    covered++;
    premiumSat += d.amountSat;
  }

  return { enrolled, covered, premiumSat, levySat, simulated: !testPayer };
}
