import { describe, expect, it } from 'vitest';
import {
  fcfaToEurCents,
  fcfaToSat,
  planPayouts,
  satToFcfa,
  xofPerBtcFromEur,
  type PlanInput,
} from './money.js';

describe('price conversion (integers only)', () => {
  it('converts EUR/BTC to XOF/BTC at the fixed 655.957 peg', () => {
    expect(xofPerBtcFromEur(57_941)).toBe(38_006_805); // 57941 × 655.957 = 38006804.537
    expect(xofPerBtcFromEur(1)).toBe(656); // 655.957 rounds half up
    expect(xofPerBtcFromEur(100_000)).toBe(65_595_700);
  });

  it('converts FCFA to sats with explicit rounding', () => {
    const xof = 38_006_805;
    // 2000 FCFA × 1e8 / 38006754 = 5262.22…
    expect(fcfaToSat(2000, xof)).toBe(5262);
    expect(fcfaToSat(2000, xof, 'ceil')).toBe(5263);
    expect(fcfaToSat(2000, xof, 'floor')).toBe(5262);
    expect(fcfaToSat(0, xof)).toBe(0);
    // exact half rounds up
    expect(fcfaToSat(1, 200_000_000)).toBe(1); // 0.5 → 1
  });

  it('converts sats back to FCFA (floor by default)', () => {
    expect(satToFcfa(5262, 38_006_805)).toBe(1999);
    expect(satToFcfa(5263, 38_006_805, 'round')).toBe(2000);
  });

  it('gives the euro equivalent of an FCFA amount in cents', () => {
    expect(fcfaToEurCents(655_957)).toBe(100_000);
    expect(fcfaToEurCents(2000)).toBe(305); // 3.049 €
  });

  it('rejects non-integers and non-positive prices', () => {
    expect(() => fcfaToSat(2000.5, 38_000_000)).toThrow(/integer/);
    expect(() => fcfaToSat(2000, 0)).toThrow(/positive/);
    expect(() => xofPerBtcFromEur(57_941.2)).toThrow(/integer/);
    expect(() => satToFcfa(-1, 38_000_000)).toThrow(/non-negative/);
  });
});

describe('planPayouts (pure payout core)', () => {
  const base: PlanInput = {
    policies: [
      { policyId: 'p1', payoutFcfa: 2000 },
      { policyId: 'p2', payoutFcfa: 2000 },
      { policyId: 'p3', payoutFcfa: 1000 },
    ],
    xofPerBtc: 38_006_805,
    balanceSat: 1_000_000,
    reserveFloorSat: 0,
    dailyCapSat: 1_000_000,
    paidTodaySat: 0,
  };

  it('pays everyone in full when the pool can afford it', () => {
    const p = planPayouts(base);
    expect(p.items.map((i) => [i.policyId, i.dueSat, i.amountSat])).toEqual([
      ['p1', 5262, 5262],
      ['p2', 5262, 5262],
      ['p3', 2631, 2631],
    ]);
    expect(p.dueSat).toBe(13_155);
    expect(p.paySat).toBe(13_155);
    expect(p.factorPpm).toBe(1_000_000);
    expect(p.shortfallSat).toBe(0);
    expect(p.limitedBy).toBeNull();
  });

  it('pays pro rata when the balance (minus the reserve floor) is short', () => {
    const p = planPayouts({ ...base, balanceSat: 8_000, reserveFloorSat: 1_000 });
    expect(p.availableSat).toBe(7_000);
    expect(p.limitedBy).toBe('balance');
    // floor(due_i × 7000 / 13155)
    expect(p.items.map((i) => i.amountSat)).toEqual([2800, 2800, 1400]);
    expect(p.paySat).toBe(7_000);
    expect(p.shortfallSat).toBe(13_155 - 7_000);
    expect(p.factorPpm).toBe(532_117); // floor(7000e6 / 13155)
  });

  it('applies the daily cap net of what was already paid today', () => {
    const p = planPayouts({ ...base, dailyCapSat: 10_000, paidTodaySat: 4_000 });
    expect(p.availableSat).toBe(6_000);
    expect(p.limitedBy).toBe('daily_cap');
    expect(p.items.map((i) => i.amountSat)).toEqual([2400, 2400, 1200]);
    expect(p.paySat).toBeLessThanOrEqual(6_000);
  });

  it('never plans more than is available, whatever the inputs', () => {
    for (let seed = 1; seed < 200; seed++) {
      const n = (seed % 7) + 1;
      const policies = Array.from({ length: n }, (_, i) => ({
        policyId: `p${i}`,
        payoutFcfa: 500 + ((seed * 37 + i * 11) % 4000),
      }));
      const p = planPayouts({
        ...base,
        policies,
        balanceSat: (seed * 7919) % 30_000,
        reserveFloorSat: (seed * 13) % 2_000,
        dailyCapSat: (seed * 104_729) % 40_000,
        paidTodaySat: (seed * 31) % 5_000,
      });
      expect(p.paySat).toBeLessThanOrEqual(p.availableSat);
      expect(p.paySat).toBe(p.items.reduce((s, i) => s + i.amountSat, 0));
      for (const i of p.items) {
        expect(Number.isInteger(i.amountSat)).toBe(true);
        expect(i.amountSat).toBeGreaterThanOrEqual(0);
        expect(i.amountSat).toBeLessThanOrEqual(i.dueSat);
      }
    }
  });

  it('plans nothing when the pool is empty, the reserve is not covered, or the cap is used up', () => {
    expect(planPayouts({ ...base, balanceSat: 0 }).paySat).toBe(0);
    expect(planPayouts({ ...base, balanceSat: 500, reserveFloorSat: 1_000 }).availableSat).toBe(0);
    const capped = planPayouts({ ...base, dailyCapSat: 5_000, paidTodaySat: 6_000 });
    expect(capped.availableSat).toBe(0);
    expect(capped.factorPpm).toBe(0);
    expect(capped.limitedBy).toBe('daily_cap');
  });

  it('handles an empty policy list', () => {
    const p = planPayouts({ ...base, policies: [] });
    expect(p.items).toEqual([]);
    expect(p.dueSat).toBe(0);
    expect(p.factorPpm).toBe(1_000_000);
  });
});
