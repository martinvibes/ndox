import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_TAG,
  attest,
  CURVE_ORDER,
  generateNonce,
  generateSecretKey,
  getPublicKey,
  noncePointFromNonce,
  normalizeSecret,
  outcomeMessage,
  recoverKey,
  signWithNonce,
  verifyAttestation,
  verifyOutcomeSignature,
} from './crypto.js';

const G = schnorr.Point.BASE;
const toBig = (hex: string) => BigInt('0x' + hex);
const toHex32 = (n: bigint) => n.toString(16).padStart(64, '0');

describe('outcome message', () => {
  it('uses the dlcspecs tag DLC/oracle/attestation/v0', () => {
    expect(ATTESTATION_TAG).toBe('DLC/oracle/attestation/v0');
  });

  it('is the BIP340 tagged hash of the UTF-8 outcome', () => {
    const tagHash = sha256(utf8ToBytes('DLC/oracle/attestation/v0'));
    const expected = sha256(concatBytes(tagHash, tagHash, utf8ToBytes('danger')));
    expect(bytesToHex(outcomeMessage('danger'))).toBe(bytesToHex(expected));
  });

  it('NFC-normalises outcomes before hashing (dlcspecs)', () => {
    const composed = 'é'; // U+00E9
    const decomposed = 'é';
    expect(bytesToHex(outcomeMessage(composed))).toBe(bytesToHex(outcomeMessage(decomposed)));
  });
});

describe('attest / verify', () => {
  it('a hand-rolled attestation passes noble schnorr.verify (cross-check)', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const nonce = generateNonce();
    const a = attest(secret, nonce.k, 'danger');
    expect(a.noncePoint).toBe(nonce.noncePoint);
    const sig = hexToBytes(a.noncePoint + a.s);
    expect(schnorr.verify(sig, outcomeMessage('danger'), hexToBytes(pub))).toBe(true);
    expect(verifyOutcomeSignature(pub, a.noncePoint, 'danger', a.s)).toBe(true);
  });

  it('produces byte-identical signatures to noble schnorr.sign when given the BIP340 nonce', () => {
    for (let i = 0; i < 20; i++) {
      const sk = hexToBytes(generateSecretKey());
      const msg = sha256(utf8ToBytes(`message ${i}`));
      const aux = sha256(utf8ToBytes(`aux ${i}`));
      const expected = schnorr.sign(msg, sk, aux);
      const k = bip340Nonce(sk, msg, aux);
      const ours = signWithNonce(bytesToHex(sk), toHex32(k), msg);
      expect(ours).toBe(bytesToHex(expected));
    }
  });

  it('matches official BIP340 test vectors 0-3 via the derived nonce', () => {
    for (const v of BIP340_VECTORS) {
      const sk = hexToBytes(v.secret);
      const msg = hexToBytes(v.msg);
      const k = bip340Nonce(sk, msg, hexToBytes(v.aux));
      const secret = v.secret.toLowerCase();
      expect(getPublicKey(secret)).toBe(v.pub.toLowerCase());
      expect(signWithNonce(secret, toHex32(k), msg)).toBe(v.sig.toLowerCase());
    }
  });

  it('fails for the wrong outcome', () => {
    const secret = generateSecretKey();
    const nonce = generateNonce();
    const a = attest(secret, nonce.k, 'calme');
    expect(verifyOutcomeSignature(getPublicKey(secret), a.noncePoint, 'danger', a.s)).toBe(false);
  });

  it('fails for the wrong public key', () => {
    const secret = generateSecretKey();
    const other = getPublicKey(generateSecretKey());
    const nonce = generateNonce();
    const a = attest(secret, nonce.k, 'danger');
    expect(verifyOutcomeSignature(other, a.noncePoint, 'danger', a.s)).toBe(false);
  });

  it('fails when the nonce point differs from the announced one', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const announced = generateNonce();
    const used = generateNonce();
    const a = attest(secret, used.k, 'danger');
    // valid BIP340 signature, but not with the committed nonce
    expect(verifyOutcomeSignature(pub, a.noncePoint, 'danger', a.s)).toBe(true);
    const res = verifyAttestation(
      { oraclePubkey: pub, noncePoint: announced.noncePoint, outcomes: ['calme', 'danger'] },
      { noncePoint: a.noncePoint, outcome: 'danger', s: a.s },
    );
    expect(res).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('fails when the outcome is not one of the announced outcomes', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const n = generateNonce();
    const a = attest(secret, n.k, 'tsunami');
    const res = verifyAttestation(
      { oraclePubkey: pub, noncePoint: n.noncePoint, outcomes: ['calme', 'danger'] },
      { noncePoint: a.noncePoint, outcome: 'tsunami', s: a.s },
    );
    expect(res).toEqual({ ok: false, reason: 'outcome_not_announced' });
  });

  it('accepts a correct attestation against its announcement', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const n = generateNonce();
    const a = attest(secret, n.k, 'indisponible');
    const res = verifyAttestation(
      { oraclePubkey: pub, noncePoint: n.noncePoint, outcomes: ['calme', 'danger', 'indisponible'] },
      { noncePoint: a.noncePoint, outcome: 'indisponible', s: a.s },
    );
    expect(res).toEqual({ ok: true });
  });

  it('rejects malformed hex and out-of-range s without throwing', () => {
    const pub = getPublicKey(generateSecretKey());
    const n = generateNonce();
    expect(verifyOutcomeSignature(pub, n.noncePoint, 'danger', 'zz')).toBe(false);
    expect(verifyOutcomeSignature(pub, n.noncePoint, 'danger', toHex32(CURVE_ORDER))).toBe(false);
    expect(verifyOutcomeSignature('00'.repeat(32), n.noncePoint, 'danger', '01'.repeat(32))).toBe(
      false,
    );
  });

  it('refuses to attest with a nonce whose point has odd Y', () => {
    const secret = generateSecretKey();
    let k = 1n;
    while (G.multiply(k).toAffine().y % 2n === 0n) k++;
    expect(() => attest(secret, toHex32(k), 'danger')).toThrow(/odd Y/);
  });
});

describe('odd-Y normalisation', () => {
  it('handles odd-Y public keys and nonce points over many random keys', () => {
    let oddP = 0;
    let oddR = 0;
    for (let i = 0; i < 200; i++) {
      const secret = generateSecretKey();
      const x = toBig(secret);
      if (G.multiply(x).toAffine().y % 2n === 1n) oddP++;
      // normalised secret always yields an even-Y point with the same x
      const xn = normalizeSecret(secret);
      const Pn = G.multiply(xn).toAffine();
      expect(Pn.y % 2n).toBe(0n);
      expect(toHex32(Pn.x)).toBe(getPublicKey(secret));

      const nonce = generateNonce((len) => crypto.getRandomValues(new Uint8Array(len)), (raw) => {
        if (G.multiply(raw).toAffine().y % 2n === 1n) oddR++;
      });
      const R = G.multiply(toBig(nonce.k)).toAffine();
      expect(R.y % 2n).toBe(0n);
      expect(toHex32(R.x)).toBe(nonce.noncePoint);
      expect(noncePointFromNonce(nonce.k)).toBe(nonce.noncePoint);

      const outcome = i % 2 ? 'calme' : 'danger';
      const a = attest(secret, nonce.k, outcome);
      expect(verifyOutcomeSignature(getPublicKey(secret), a.noncePoint, outcome, a.s)).toBe(true);
    }
    // statistically both branches must have been exercised
    expect(oddP).toBeGreaterThan(50);
    expect(oddR).toBeGreaterThan(50);
  });
});

describe('equivocation', () => {
  it('signing two outcomes with the same nonce leaks the oracle key', () => {
    for (let i = 0; i < 25; i++) {
      const secret = generateSecretKey();
      const pub = getPublicKey(secret);
      const n = generateNonce();
      const a1 = attest(secret, n.k, 'calme');
      const a2 = attest(secret, n.k, 'danger');
      const recovered = recoverKey(pub, a1, a2);
      expect(recovered).toBe(toHex32(normalizeSecret(secret)));
      expect(getPublicKey(recovered)).toBe(pub);
      // the recovered key can sign anything as the oracle
      const forged = attest(recovered, generateNonce().k, 'indisponible');
      expect(verifyOutcomeSignature(pub, forged.noncePoint, 'indisponible', forged.s)).toBe(true);
    }
  });

  it('refuses attestations with different nonces or identical outcomes', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const n1 = generateNonce();
    const n2 = generateNonce();
    const a = attest(secret, n1.k, 'calme');
    const b = attest(secret, n2.k, 'danger');
    expect(() => recoverKey(pub, a, b)).toThrow(/same nonce/);
    expect(() => recoverKey(pub, a, a)).toThrow(/different outcomes/);
  });

  it('refuses invalid signatures', () => {
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    const n = generateNonce();
    const a = attest(secret, n.k, 'calme');
    const b = { ...attest(secret, n.k, 'danger'), s: toHex32(12345n) };
    expect(() => recoverKey(pub, a, b)).toThrow(/invalid/);
  });
});

describe('nonce generation', () => {
  it('never returns the same nonce twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateNonce().k);
    expect(seen.size).toBe(500);
  });

  it('rejects out-of-range random draws and retries', () => {
    const draws = [new Uint8Array(32), hexToBytes(toHex32(CURVE_ORDER)), hexToBytes(toHex32(7n))];
    const n = generateNonce(() => draws.shift()!);
    expect([toHex32(7n), toHex32(CURVE_ORDER - 7n)]).toContain(n.k);
  });
});

// ---- helpers --------------------------------------------------------------

/** BIP340 default nonce derivation (reference algorithm, written independently of the code under test). */
function bip340Nonce(sk: Uint8Array, msg: Uint8Array, aux: Uint8Array): bigint {
  const n = CURVE_ORDER;
  let d = toBig(bytesToHex(sk));
  const P = G.multiply(d).toAffine();
  if (P.y % 2n === 1n) d = n - d;
  const t = toBig(bytesToHex(schnorr.utils.taggedHash('BIP0340/aux', aux))) ^ d;
  const rand = schnorr.utils.taggedHash(
    'BIP0340/nonce',
    hexToBytes(toHex32(t)),
    hexToBytes(toHex32(P.x)),
    msg,
  );
  const k0 = toBig(bytesToHex(rand)) % n;
  const R = G.multiply(k0).toAffine();
  return R.y % 2n === 0n ? k0 : n - k0;
}

// https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv (indices 0-3)
const BIP340_VECTORS = [
  {
    secret: '0000000000000000000000000000000000000000000000000000000000000003',
    pub: 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0000000000000000000000000000000000000000000000000000000000000000',
    sig: 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
  },
  {
    secret: 'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF',
    pub: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A',
  },
  {
    secret: 'C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9',
    pub: 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    aux: 'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906',
    msg: '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    sig: '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7',
  },
  {
    secret: '0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710',
    pub: '25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517',
    aux: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    msg: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    sig: '7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3',
  },
];
