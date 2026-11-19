import { describe, expect, it } from 'vitest';
import { deriveKey, open, seal } from './box.js';

const SECRET = 'ab'.repeat(32);

describe('sealed box', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const key = deriveKey(SECRET, 'nonce');
    const a = seal(key, 'hello', 'ctx');
    const b = seal(key, 'hello', 'ctx');
    expect(a).not.toBe(b);
    expect(open(key, a, 'ctx')).toBe('hello');
    expect(open(key, b, 'ctx')).toBe('hello');
  });

  it('derives independent keys per purpose', () => {
    expect(deriveKey(SECRET, 'nonce').equals(deriveKey(SECRET, 'pii'))).toBe(false);
    expect(deriveKey(SECRET, 'nonce').equals(deriveKey(SECRET, 'nonce'))).toBe(true);
    expect(() => deriveKey('AB'.repeat(32), 'nonce')).toThrow();
  });

  it('fails on wrong key, wrong context or tampering', () => {
    const key = deriveKey(SECRET, 'nonce');
    const sealed = seal(key, 'secret nonce', 'ndox:kayar:2026-02-27');
    expect(() => open(deriveKey(SECRET, 'pii'), sealed, 'ndox:kayar:2026-02-27')).toThrow(
      /cannot decrypt/,
    );
    expect(() => open(key, sealed, 'ndox:kayar:2026-02-28')).toThrow(/cannot decrypt/);
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[2] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], ct.toString('base64url'), parts[3]].join('.');
    expect(() => open(key, tampered, 'ndox:kayar:2026-02-27')).toThrow(/cannot decrypt/);
    expect(() => open(key, 'v2.a.b.c', 'x')).toThrow(/unsupported/);
  });
});
