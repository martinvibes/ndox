/**
 * Admin sessions (docs/BRIEF.md §14 "Admin takeover"): a random session id in an httpOnly,
 * SameSite=Strict cookie scoped to /api/admin (Secure on https), kept in memory (a restart logs
 * the treasurer out). Every state-changing request also needs the CSRF token (an HMAC of the
 * session id under SESSION_SECRET) in `x-csrf-token`, and a same-origin `Origin` header if any.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { deriveKey } from '../lib/box.js';
import { equalStrings } from '../lib/password.js';

export const SESSION_COOKIE = 'ndox_admin';
export const SESSION_TTL_MS = 12 * 3600_000;
const MAX_SESSIONS = 100;

export interface AdminSession {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export interface SessionStoreOptions {
  sessionSecret: string;
  /** Cookies get the Secure flag (PUBLIC_BASE_URL is https). */
  secure: boolean;
  ttlMs?: number;
  now?: () => number;
}

export class SessionStore {
  private readonly sessions = new Map<string, number>();
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly o: SessionStoreOptions) {
    this.key = deriveKey(o.sessionSecret, 'admin-session');
    this.ttlMs = o.ttlMs ?? SESSION_TTL_MS;
    this.now = o.now ?? Date.now;
  }

  private csrf(id: string): string {
    return createHmac('sha256', this.key).update(`csrf:${id}`).digest('base64url');
  }

  create(): AdminSession {
    const t = this.now();
    for (const [id, exp] of this.sessions) if (exp <= t) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    const expiresAt = t + this.ttlMs;
    this.sessions.set(id, expiresAt);
    return { id, csrfToken: this.csrf(id), expiresAt };
  }

  get(id: string | undefined): AdminSession | null {
    if (!id) return null;
    const exp = this.sessions.get(id);
    if (exp === undefined) return null;
    if (exp <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return { id, csrfToken: this.csrf(id), expiresAt: exp };
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  checkCsrf(session: AdminSession, token: unknown): boolean {
    return typeof token === 'string' && equalStrings(token, session.csrfToken);
  }

  setCookie(reply: FastifyReply, s: AdminSession): void {
    const maxAge = Math.max(0, Math.floor((s.expiresAt - this.now()) / 1000));
    reply.header('set-cookie', this.cookie(s.id, maxAge));
  }

  clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', this.cookie('', 0));
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/api/admin',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(this.o.secure ? ['Secure'] : []),
    ].join('; ');
  }
}

export function readSessionCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
    }
  }
  return undefined;
}

/**
 * A browser sends Origin on cross-site and on same-origin POSTs; it must be ours. Requests
 * without one (curl, the CLI) are not browser forgeries and still need the CSRF token.
 */
export function originAllowed(
  req: FastifyRequest,
  publicBaseUrl: string,
  allowLocalhost: boolean,
): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === new URL(publicBaseUrl).origin) return true;
  return allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}
