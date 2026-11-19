import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { amountPart, encodeBolt11, paymentHashOf, recoverPayee } from './bolt11.js';

const nodeKey = '3c'.repeat(32);
const preimage = 'ab'.repeat(32);
const paymentHash = bytesToHex(sha256(Buffer.from(preimage, 'hex')));

describe('BOLT11 encoder (FakeWallet invoices)', () => {
  it('encodes amounts with the largest exact multiplier', () => {
    expect(amountPart(1)).toBe('10n');
    expect(amountPart(5262)).toBe('52620n');
    expect(amountPart(2500)).toBe('25u');
    expect(amountPart(100_000)).toBe('1m');
    expect(amountPart(150_000)).toBe('1500u');
    expect(() => amountPart(0)).toThrow();
    expect(() => amountPart(1.5)).toThrow();
  });

  it('produces a regtest invoice that a standard decoder reads back exactly', () => {
    const inv = encodeBolt11({
      amountSat: 5262,
      paymentHash,
      paymentSecret: 'cd'.repeat(32),
      description: 'Ndox paiement test',
      timestamp: 1_795_000_000,
      expirySec: 3600,
      nodeKey,
    });
    expect(inv.startsWith('lnbcrt52620n1')).toBe(true);
    const d = decodeInvoice(inv);
    expect(d).toMatchObject({
      paymentHash,
      satoshi: 5262,
      millisatoshi: 5_262_000,
      timestamp: 1_795_000_000,
      expiry: 3600,
      description: 'Ndox paiement test',
    });
    expect(paymentHashOf(inv)).toBe(paymentHash);
  });

  it('is signed by the node key (recoverable signature, as BOLT11 requires)', () => {
    const inv = encodeBolt11({
      amountSat: 21,
      paymentHash,
      paymentSecret: '01'.repeat(32),
      description: 'x',
      timestamp: 1_795_000_000,
      expirySec: 60,
      nodeKey,
    });
    expect(recoverPayee(inv)).toBe(bytesToHex(secp256k1.getPublicKey(Buffer.from(nodeKey, 'hex'))));
  });

  it('is deterministic', () => {
    const p = {
      amountSat: 1000,
      paymentHash,
      paymentSecret: '02'.repeat(32),
      description: 'd',
      timestamp: 1,
      expirySec: 10,
      nodeKey,
    };
    expect(encodeBolt11(p)).toBe(encodeBolt11(p));
  });

  it('paymentHashOf rejects garbage', () => {
    expect(paymentHashOf('lnbc1garbage')).toBeNull();
    expect(paymentHashOf('')).toBeNull();
  });
});
