/**
 * Minimal BOLT11 encoder for FakeWallet invoices. They are real, signed BOLT11 invoices on the
 * regtest prefix (`lnbcrt`), so any decoder reads them, while no mainnet or signet wallet will
 * ever try to pay one. Decoding uses @getalby/lightning-tools.
 *
 * Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';

export const FAKE_HRP = 'lnbcrt';

/** BOLT11 amount for whole sats: the largest multiplier that divides exactly (1 sat = 10n). */
export function amountPart(amountSat: number): string {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0)
    throw new RangeError('amountSat must be a positive integer');
  if (amountSat % 100_000 === 0) return `${amountSat / 100_000}m`;
  if (amountSat % 100 === 0) return `${amountSat / 100}u`;
  return `${amountSat * 10}n`;
}

function intToWords(value: number, minWords = 1): number[] {
  const words: number[] = [];
  let v = value;
  while (v > 0) {
    words.unshift(v & 31);
    v = Math.floor(v / 32);
  }
  while (words.length < minWords) words.unshift(0);
  return words;
}

function tagged(type: number, data: number[]): number[] {
  if (data.length >= 1024) throw new RangeError('tagged field too long');
  return [type, data.length >> 5, data.length & 31, ...data];
}

/** 5-bit words → bytes, zero-padded to the next byte boundary (as BOLT11 signs them). */
function wordsToBytesPadded(words: readonly number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

function signingHash(hrp: string, dataWords: readonly number[]): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(hrp), wordsToBytesPadded(dataWords)));
}

const TAG = { p: 1, s: 16, d: 13, x: 6, features: 5 } as const;
/** var_onion_optin (bit 8) and payment_secret (bit 14), both compulsory. */
const FEATURES = (1 << 8) | (1 << 14);

export interface EncodeParams {
  amountSat: number;
  paymentHash: string;
  paymentSecret: string;
  description: string;
  /** Unix seconds. */
  timestamp: number;
  expirySec: number;
  /** Hex secret key of the fake node that "issues" the invoice. */
  nodeKey: string;
}

export function encodeBolt11(p: EncodeParams): string {
  const hrp = `${FAKE_HRP}${amountPart(p.amountSat)}`;
  const data = [
    ...intToWords(p.timestamp, 7),
    ...tagged(TAG.p, bech32.toWords(hexToBytes(p.paymentHash))),
    ...tagged(TAG.s, bech32.toWords(hexToBytes(p.paymentSecret))),
    ...tagged(TAG.d, bech32.toWords(utf8ToBytes(p.description))),
    ...tagged(TAG.x, intToWords(p.expirySec)),
    ...tagged(TAG.features, intToWords(FEATURES)),
  ];
  const recovered = secp256k1.sign(signingHash(hrp, data), hexToBytes(p.nodeKey), {
    prehash: false,
    format: 'recovered',
  });
  // noble: recid ‖ r ‖ s — BOLT11: r ‖ s ‖ recid
  const sig = concatBytes(recovered.subarray(1), recovered.subarray(0, 1));
  return bech32.encode(hrp, [...data, ...bech32.toWords(sig)], false);
}

/** Compressed public key of the node that signed the invoice. */
export function recoverPayee(invoice: string): string {
  const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, false);
  const data = words.slice(0, -104);
  const sig = wordsToBytesPadded(words.slice(-104)).subarray(0, 65);
  const recovered = concatBytes(sig.subarray(64, 65), sig.subarray(0, 64));
  return bytesToHex(
    secp256k1.recoverPublicKey(recovered, signingHash(prefix, data), { prehash: false }),
  );
}

/** Payment hash of any BOLT11 invoice, or null if it does not decode. */
export function paymentHashOf(invoice: string): string | null {
  return decodeInvoice(invoice)?.paymentHash ?? null;
}
