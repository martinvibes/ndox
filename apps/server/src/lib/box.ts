/**
 * Authenticated encryption at rest (AES-256-GCM) with keys derived by HKDF-SHA256.
 * Used for oracle nonces (key derived from the oracle secret) and PII (PII_ENCRYPTION_KEY).
 *
 * Sealed format: "v1.<iv>.<ciphertext>.<tag>" (base64url). The AAD binds a ciphertext to its
 * row (e.g. the event id), so a ciphertext copied to another row fails to open.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const HEX32 = /^[0-9a-f]{64}$/;

export function deriveKey(secretHex: string, purpose: string): Buffer {
  if (!HEX32.test(secretHex)) throw new Error('secret must be 32 bytes of lowercase hex');
  if (!/^[a-z0-9-]+$/.test(purpose)) throw new Error('invalid key purpose');
  const okm = hkdfSync('sha256', Buffer.from(secretHex, 'hex'), 'ndox', `ndox/${purpose}/v1`, 32);
  return Buffer.from(okm);
}

export function seal(key: Buffer, plaintext: string, aad: string): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, ct, tag]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported sealed format');
  const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('cannot decrypt (wrong key, wrong context or tampered data)');
  }
}
