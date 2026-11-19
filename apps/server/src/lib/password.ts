/**
 * Admin password hashing (scrypt, node:crypto). Stored format, one line, safe in an env file:
 *
 *   scrypt$<log2 N>$<r>$<p>$<salt base64url>$<hash base64url>
 *
 * Generate one with `printf '%s' 'the password' | pnpm ndox hash-password`.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { deriveKey } from './box.js';

const KEY_LEN = 32;
const DEFAULT_LOG_N = 15; // N = 32768, r = 8: 32 MiB, ~50–100 ms per check

export class PasswordHashError extends Error {}

function run(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r * p };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, KEY_LEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string, logN = DEFAULT_LOG_N): Promise<string> {
  if (password.length < 12) throw new PasswordHashError('password must be at least 12 characters');
  const salt = randomBytes(16);
  const key = await run(password, salt, logN, 8, 1);
  return `scrypt$${logN}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Throws if `stored` is not a hash this module produced (a configuration error). */
export function parsePasswordHash(stored: string): {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
} {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43})$/.exec(
    stored.trim(),
  );
  const [logN, r, p] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  if (!m || logN < 14 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4)
    throw new PasswordHashError(
      'ADMIN_PASSWORD_HASH is not a valid scrypt hash (see .env.example)',
    );
  return {
    logN,
    r,
    p,
    salt: Buffer.from(m[4]!, 'base64url'),
    key: Buffer.from(m[5]!, 'base64url'),
  };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parsePasswordHash(stored);
  const key = await run(password, h.salt, h.logN, h.r, h.p);
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 symbols: no 0/o, 1/l

/**
 * WALLET_MODE=fake without ADMIN_PASSWORD_HASH: a password derived from SESSION_SECRET, so a
 * fresh `docker compose up` has a working, non-guessable login. Shown only by
 * `ndox admin-password`, never logged.
 */
export function derivedAdminPassword(sessionSecretHex: string): string {
  const bytes = deriveKey(sessionSecretHex, 'admin-password');
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i]! % 32];
  return s.match(/.{4}/g)!.join('-');
}

export function equalStrings(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
