/**
 * Security headers on every response (docs/BRIEF.md §14, Phase 7).
 * The CSP allows only this origin, plus `wss:` so the browser verifier can ask Nostr relays
 * itself. Inline styles stay allowed (React style attributes, the script-free crew page's
 * <style>); inline scripts never are.
 */
import type { FastifyInstance } from 'fastify';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function registerSecurityHeaders(app: FastifyInstance, o: { https: boolean }): void {
  const csp = o.https ? `${CSP}; upgrade-insecure-requests` : CSP;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('content-security-policy', csp);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!reply.hasHeader('referrer-policy'))
      reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (o.https) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
}
