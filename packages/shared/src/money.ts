/**
 * Money maths, integers only (docs/BRIEF.md ground rule 4). Amounts are FCFA (XOF) and sats;
 * prices are integer XOF per BTC. Divisions go through BigInt with an explicit rounding mode,
 * so the server, the browser verifier and the tests all get the same numbers.
 *
 * Shared with the web app so the public page can re-check payout receipts.
 */

/** The CFA franc peg: 1 EUR = 655.957 XOF, exactly. */
export const XOF_PER_EUR_MILLI = 655_957n;
export const SATS_PER_BTC = 100_000_000;

export type Rounding = 'floor' | 'ceil' | 'round';

function int(name: string, v: number, min: 'non-negative' | 'positive'): bigint {
  if (!Number.isSafeInteger(v)) throw new RangeError(`${name} must be a safe integer, got ${v}`);
  if (min === 'positive' && v <= 0) throw new RangeError(`${name} must be positive, got ${v}`);
  if (min === 'non-negative' && v < 0)
    throw new RangeError(`${name} must be non-negative, got ${v}`);
  return BigInt(v);
}

/** num / den for non-negative num and positive den, rounded as asked ('round' = half up). */
export function divide(num: bigint, den: bigint, mode: Rounding): bigint {
  if (den <= 0n || num < 0n) throw new RangeError('divide expects num >= 0 and den > 0');
  const q = num / den;
  const r = num % den;
  if (r === 0n || mode === 'floor') return q;
  if (mode === 'ceil') return q + 1n;
  return r * 2n >= den ? q + 1n : q;
}

function toNumber(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError('result exceeds the safe integer range');
  return n;
}

/** Integer XOF per BTC from an integer EUR per BTC price (rounded half up). */
export function xofPerBtcFromEur(eurPerBtc: number): number {
  return toNumber(
    divide(int('eurPerBtc', eurPerBtc, 'positive') * XOF_PER_EUR_MILLI, 1000n, 'round'),
  );
}

/**
 * Sats for an FCFA amount. Use 'round' for payouts and 'ceil' for invoices the pool asks others
 * to pay (so a premium is never short by a rounding sat).
 */
export function fcfaToSat(fcfa: number, xofPerBtc: number, mode: Rounding = 'round'): number {
  const f = int('fcfa', fcfa, 'non-negative');
  const p = int('xofPerBtc', xofPerBtc, 'positive');
  return toNumber(divide(f * BigInt(SATS_PER_BTC), p, mode));
}

/** FCFA for a sat amount (floor by default: never overstate what a payment was worth). */
export function satToFcfa(sat: number, xofPerBtc: number, mode: Rounding = 'floor'): number {
  const s = int('sat', sat, 'non-negative');
  const p = int('xofPerBtc', xofPerBtc, 'positive');
  return toNumber(divide(s * p, BigInt(SATS_PER_BTC), mode));
}

/** Euro cents for an FCFA amount (display only, rounded half up). */
export function fcfaToEurCents(fcfa: number): number {
  return toNumber(
    divide(int('fcfa', fcfa, 'non-negative') * 100n * 1000n, XOF_PER_EUR_MILLI, 'round'),
  );
}

// ---------------------------------------------------------------------------
// Payout planning: the pure core of the payout engine (docs/BRIEF.md §7.3).

export interface PlanPolicy {
  policyId: string;
  payoutFcfa: number;
}

export interface PlanInput {
  policies: readonly PlanPolicy[];
  xofPerBtc: number;
  /** Wallet balance at planning time. */
  balanceSat: number;
  /** Sats the pool always keeps (never paid out). */
  reserveFloorSat: number;
  /** App-side daily payout cap (DAILY_PAYOUT_CAP_SATS). */
  dailyCapSat: number;
  /** Sats already committed to payouts today (UTC). */
  paidTodaySat: number;
}

export interface PlanItem {
  policyId: string;
  amountFcfa: number;
  /** Full amount due at this price, before any pro-rata reduction. */
  dueSat: number;
  /** What will actually be paid: floor(dueSat × available / totalDue) when short. */
  amountSat: number;
}

export interface PayoutPlan {
  items: PlanItem[];
  dueSat: number;
  availableSat: number;
  paySat: number;
  shortfallSat: number;
  /** The factor applied, available / due, in parts per million, floored (1_000_000 = paid in full). */
  factorPpm: number;
  /** What limited the payout, if anything. */
  limitedBy: 'balance' | 'daily_cap' | null;
}

export const PPM = 1_000_000;

/**
 *   due       = Σ dueSat_i                         (dueSat_i = payoutFcfa_i in sats, rounded)
 *   available = max(0, min(balance − reserve floor, daily cap − paid today))
 *   pay_i     = due ≤ available ? dueSat_i : floor(dueSat_i × available / due)
 *
 * Σ pay_i ≤ available always holds; the leftover rounding sats stay in the pool.
 */
export function planPayouts(input: PlanInput): PayoutPlan {
  const byBalance = int('balanceSat', input.balanceSat, 'non-negative');
  const floorSat = int('reserveFloorSat', input.reserveFloorSat, 'non-negative');
  const cap = int('dailyCapSat', input.dailyCapSat, 'non-negative');
  const paidToday = int('paidTodaySat', input.paidTodaySat, 'non-negative');
  const fromBalance = byBalance > floorSat ? byBalance - floorSat : 0n;
  const fromCap = cap > paidToday ? cap - paidToday : 0n;
  const available = fromBalance < fromCap ? fromBalance : fromCap;

  const dues = input.policies.map((p) => ({
    policyId: p.policyId,
    amountFcfa: p.payoutFcfa,
    dueSat: BigInt(fcfaToSat(p.payoutFcfa, input.xofPerBtc, 'round')),
  }));
  const due = dues.reduce((s, d) => s + d.dueSat, 0n);
  const full = available >= due;

  const items: PlanItem[] = dues.map((d) => ({
    policyId: d.policyId,
    amountFcfa: d.amountFcfa,
    dueSat: toNumber(d.dueSat),
    amountSat: toNumber(full ? d.dueSat : divide(d.dueSat * available, due, 'floor')),
  }));
  const pay = items.reduce((s, i) => s + BigInt(i.amountSat), 0n);
  const limitedBy = full ? null : fromCap < fromBalance ? 'daily_cap' : 'balance';

  return {
    items,
    dueSat: toNumber(due),
    availableSat: toNumber(available),
    paySat: toNumber(pay),
    shortfallSat: toNumber(due - pay),
    factorPpm: full ? PPM : toNumber(divide(available * BigInt(PPM), due, 'floor')),
    limitedBy,
  };
}
