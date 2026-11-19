import { describe, expect, it } from 'vitest';
import {
  derivedAdminPassword,
  equalStrings,
  hashPassword,
  parsePasswordHash,
  PasswordHashError,
  verifyPassword,
} from './password.js';

describe('password', () => {
  it('hashes with a fresh salt and verifies', async () => {
    const a = await hashPassword('correct horse battery', 14);
    const b = await hashPassword('correct horse battery', 14);
    expect(a).toMatch(/^scrypt\$14\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('refuses short passwords and malformed or weak hashes', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordHashError);
    expect(() => parsePasswordHash('plaintext')).toThrow(PasswordHashError);
    expect(() => parsePasswordHash(`scrypt$10$8$1$${'a'.repeat(22)}$${'b'.repeat(43)}`)).toThrow(
      PasswordHashError,
    );
    await expect(verifyPassword('x', '$2b$10$bcrypt')).rejects.toBeInstanceOf(PasswordHashError);
  });

  it('derives a stable, readable admin password from the session secret', () => {
    const p = derivedAdminPassword('44'.repeat(32));
    expect(p).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);
    expect(derivedAdminPassword('44'.repeat(32))).toBe(p);
    expect(derivedAdminPassword('45'.repeat(32))).not.toBe(p);
  });

  it('compares strings in constant time', () => {
    expect(equalStrings('abc', 'abc')).toBe(true);
    expect(equalStrings('abc', 'abd')).toBe(false);
    expect(equalStrings('abc', 'abcd')).toBe(false);
  });
});
