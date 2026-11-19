/**
 * DLC-style oracle cryptography: BIP340 Schnorr signatures with a nonce that is
 * committed (announced) before the outcome is known.
 *
 * Because the nonce point R is published in advance, the oracle can only sign
 * ONE outcome per announcement. Signing two different outcomes with the same R
 * reveals the oracle's secret key to anyone (see `recoverKey`).
 *
 * References:
 *  - BIP340: https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
 *  - dlcspecs Oracle.md: Sign(sk, msg, tag) = BIP340_sign(sk, tag_hash("DLC/oracle/" || tag)(msg)),
 *    with tag "attestation/v0" and outcomes encoded as NFC-normalised UTF-8.
 */
import { invert, mod } from '@noble/curves/abstract/modular.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js';

const Point = schnorr.Point;
const G = Point.BASE;

/** secp256k1 group order n. */
export const CURVE_ORDER: bigint = Point.Fn.ORDER;

/** dlcspecs Oracle.md: tag_hash("DLC/oracle/" || "attestation/v0"). */
export const ATTESTATION_TAG = 'DLC/oracle/attestation/v0';

const HEX32 = /^[0-9a-f]{64}$/;

function assertHex32(value: string, name: string): void {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`${name} must be 32 bytes of lowercase hex`);
  }
}

function hexToScalar(hex: string, name: string): bigint {
  assertHex32(hex, name);
  const n = BigInt('0x' + hex);
  if (n <= 0n || n >= CURVE_ORDER) throw new Error(`${name} is out of range`);
  return n;
}

function scalarToHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function bytesToBigint(b: Uint8Array): bigint {
  return BigInt('0x' + (bytesToHex(b) || '0'));
}

function hasEvenY(p: InstanceType<typeof Point>): boolean {
  return p.toAffine().y % 2n === 0n;
}

/** Fresh random secret key (32-byte hex). */
export function generateSecretKey(): string {
  return bytesToHex(schnorr.utils.randomSecretKey());
}

/** x-only public key (32-byte hex) for a secret key. */
export function getPublicKey(secretHex: string): string {
  assertHex32(secretHex, 'secret');
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
}

/**
 * BIP340 normalisation: returns x such that x·G has an even Y coordinate.
 * The x-only public key is the same for x and n − x.
 */
export function normalizeSecret(secretHex: string): bigint {
  const x = hexToScalar(secretHex, 'secret');
  return hasEvenY(G.multiply(x)) ? x : CURVE_ORDER - x;
}

export interface Nonce {
  /** Secret nonce scalar k (32-byte hex), normalised so that k·G has even Y. KEEP SECRET, use once. */
  k: string;
  /** x coordinate of R = k·G (32-byte hex). This is what gets announced. */
  noncePoint: string;
}

/**
 * Draw a fresh nonce for one announcement.
 * @param rand    source of randomness (defaults to the platform CSPRNG); injectable for tests.
 * @param onDraw  test hook, receives each accepted raw scalar before normalisation.
 */
export function generateNonce(
  rand: (len: number) => Uint8Array = randomBytes,
  onDraw?: (raw: bigint) => void,
): Nonce {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const raw = bytesToBigint(rand(32));
    if (raw <= 0n || raw >= CURVE_ORDER) continue;
    onDraw?.(raw);
    const R = G.multiply(raw);
    const k = hasEvenY(R) ? raw : CURVE_ORDER - raw;
    return { k: scalarToHex(k), noncePoint: bytesToHex(schnorr.utils.pointToBytes(R)) };
  }
  throw new Error('could not draw a valid nonce');
}

/** R.x for a (normalised) secret nonce. */
export function noncePointFromNonce(kHex: string): string {
  const k = hexToScalar(kHex, 'nonce');
  return bytesToHex(schnorr.utils.pointToBytes(G.multiply(k)));
}

/** m = taggedHash("DLC/oracle/attestation/v0", utf8(NFC(outcome))). */
export function outcomeMessage(outcome: string): Uint8Array {
  return schnorr.utils.taggedHash(ATTESTATION_TAG, utf8ToBytes(outcome.normalize('NFC')));
}

function challenge(Rx: Uint8Array, Px: Uint8Array, m: Uint8Array): bigint {
  return mod(bytesToBigint(schnorr.utils.taggedHash('BIP0340/challenge', Rx, Px, m)), CURVE_ORDER);
}

/**
 * Low-level BIP340 signature with a caller-supplied nonce. Returns the 64-byte signature as hex.
 * The nonce must already be normalised (k·G has even Y).
 */
export function signWithNonce(secretHex: string, kHex: string, message: Uint8Array): string {
  const x = normalizeSecret(secretHex);
  const k = hexToScalar(kHex, 'nonce');
  const R = G.multiply(k);
  if (!hasEvenY(R)) throw new Error('nonce point has odd Y; normalise k first');
  const Rx = schnorr.utils.pointToBytes(R);
  const Px = schnorr.utils.pointToBytes(G.multiply(x));
  const e = challenge(Rx, Px, message);
  const s = mod(k + e * x, CURVE_ORDER);
  return bytesToHex(concatBytes(Rx, hexToBytes(scalarToHex(s))));
}

export interface Attestation {
  outcome: string;
  /** R.x (32-byte hex) — must equal the announced nonce point. */
  noncePoint: string;
  /** s (32-byte hex). The full BIP340 signature is noncePoint ‖ s. */
  s: string;
}

/** Sign `outcome` with the pre-committed nonce `kHex`. */
export function attest(secretHex: string, kHex: string, outcome: string): Attestation {
  const sig = signWithNonce(secretHex, kHex, outcomeMessage(outcome));
  return { outcome, noncePoint: sig.slice(0, 64), s: sig.slice(64) };
}

/** Standard BIP340 verification of (R ‖ s) over the outcome message. Never throws. */
export function verifyOutcomeSignature(
  oraclePubkey: string,
  noncePoint: string,
  outcome: string,
  s: string,
): boolean {
  try {
    if (!HEX32.test(oraclePubkey) || !HEX32.test(noncePoint) || !HEX32.test(s)) return false;
    return schnorr.verify(
      hexToBytes(noncePoint + s),
      outcomeMessage(outcome),
      hexToBytes(oraclePubkey),
    );
  } catch {
    return false;
  }
}

export interface AnnouncementCommitment {
  oraclePubkey: string;
  noncePoint: string;
  outcomes: readonly string[];
}

export type AttestationCheck =
  | { ok: true }
  | { ok: false; reason: 'nonce_mismatch' | 'outcome_not_announced' | 'bad_signature' };

/**
 * Full oracle check: the attestation must use the announced nonce point, sign one of the
 * announced outcomes, and be a valid BIP340 signature under the oracle key.
 */
export function verifyAttestation(
  announcement: AnnouncementCommitment,
  attestation: Pick<Attestation, 'noncePoint' | 'outcome' | 's'>,
): AttestationCheck {
  if (attestation.noncePoint !== announcement.noncePoint) {
    return { ok: false, reason: 'nonce_mismatch' };
  }
  if (!announcement.outcomes.includes(attestation.outcome)) {
    return { ok: false, reason: 'outcome_not_announced' };
  }
  const valid = verifyOutcomeSignature(
    announcement.oraclePubkey,
    attestation.noncePoint,
    attestation.outcome,
    attestation.s,
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Equivocation recovery. Given two valid attestations by `oraclePubkey` that reuse the same
 * nonce point for different outcomes, compute the oracle secret:
 *   s1 = k + e1·x,  s2 = k + e2·x  ⇒  x = (s1 − s2) · (e1 − e2)⁻¹ mod n
 * Returns the BIP340-normalised secret (its x-only public key equals `oraclePubkey`).
 */
export function recoverKey(oraclePubkey: string, a1: Attestation, a2: Attestation): string {
  if (a1.noncePoint !== a2.noncePoint) throw new Error('attestations must share the same nonce');
  if (a1.outcome.normalize('NFC') === a2.outcome.normalize('NFC')) {
    throw new Error('attestations must be for different outcomes');
  }
  for (const a of [a1, a2]) {
    if (!verifyOutcomeSignature(oraclePubkey, a.noncePoint, a.outcome, a.s)) {
      throw new Error('invalid attestation signature');
    }
  }
  const Rx = hexToBytes(a1.noncePoint);
  const Px = hexToBytes(oraclePubkey);
  const e1 = challenge(Rx, Px, outcomeMessage(a1.outcome));
  const e2 = challenge(Rx, Px, outcomeMessage(a2.outcome));
  const s1 = BigInt('0x' + a1.s);
  const s2 = BigInt('0x' + a2.s);
  const x = mod((s1 - s2) * invert(mod(e1 - e2, CURVE_ORDER), CURVE_ORDER), CURVE_ORDER);
  const recovered = scalarToHex(x);
  if (getPublicKey(recovered) !== oraclePubkey) throw new Error('recovery failed');
  return recovered;
}
