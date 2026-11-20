/**
 * Crew-facing routes (docs/BRIEF.md §9): the status page and its JSON, the USSD menu and the SMS
 * delivery reports. Status lookups are rate-limited (codes are short) and never return PII.
 * Operator callbacks (USSD, delivery reports) are not signed by Africa's Talking: when
 * AT_CALLBACK_TOKEN is set, the callback URL must carry it as `?token=`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { codeFormPage, crewPage } from '../crew/page.js';
import { crewByCode, crewStatus, normaliseStatusCode } from '../crew/status.js';
import { equalStrings } from '../lib/password.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { recordDelivery } from '../notify/jobs.js';
import { ussdReply } from '../notify/ussd.js';
import type { Services } from '../services.js';

const CodeParam = z.object({ code: z.string().max(12) });
const UssdBody = z.object({
  sessionId: z.string().max(100).optional(),
  serviceCode: z.string().max(40).optional(),
  phoneNumber: z.string().max(20),
  text: z.string().max(200).default(''),
});
const DeliveryBody = z.object({
  id: z.string().min(1).max(100),
  status: z.string().min(1).max(40),
  failureReason: z.string().max(100).optional(),
});

export function registerCrewRoutes(app: FastifyInstance, s: Services): void {
  const lookups = new RateLimiter(30, 60_000);
  const limited = (req: FastifyRequest, reply: FastifyReply) => {
    const wait = lookups.take(`status:${req.ip}`);
    if (!wait) return false;
    void reply.code(429).header('retry-after', String(wait)).send({ error: 'rate_limited' });
    return true;
  };
  const html = (reply: FastifyReply, body: string, code = 200) =>
    reply
      .code(code)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send(body);

  app.get('/api/status/:code', async (req, reply) => {
    if (limited(req, reply)) return reply;
    const p = CodeParam.safeParse(req.params);
    const crew = p.success ? crewByCode(s.db, p.data.code) : undefined;
    reply.header('cache-control', 'no-store');
    if (!crew) return reply.code(404).send({ error: 'unknown_code' });
    return { ...crewStatus(s.db, crew, s.clock()), testFunds: s.money.testFunds === true };
  });

  app.get('/e', async (req, reply) => {
    const q = z.object({ code: z.string().max(12).optional() }).safeParse(req.query);
    const code = q.success && q.data.code ? normaliseStatusCode(q.data.code) : null;
    if (q.success && q.data.code)
      return code
        ? reply.redirect(`/e/${code}`, 303)
        : html(reply, codeFormPage('Ce code n’a pas le bon format (6 caractères).'), 400);
    return html(reply, codeFormPage());
  });

  app.get('/e/:code', async (req, reply) => {
    if (limited(req, reply)) return reply;
    const p = CodeParam.safeParse(req.params);
    const crew = p.success ? crewByCode(s.db, p.data.code) : undefined;
    if (!crew) return html(reply, codeFormPage('Code inconnu. Vérifiez-le auprès du CLPA.'), 404);
    const now = s.clock();
    return html(
      reply,
      crewPage(crewStatus(s.db, crew, now), { now, testFunds: s.money.testFunds === true }),
    );
  });

  // ── Africa's Talking callbacks (form-encoded) ─────────────────────────────────────────────
  void app.register(async (at) => {
    at.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    const token = s.config.africasTalking.callbackToken;
    const allowed = (req: FastifyRequest) => {
      if (!token) return true;
      const t = (req.query as { token?: unknown }).token;
      return typeof t === 'string' && equalStrings(t, token);
    };
    const callbacks = new RateLimiter(300, 60_000);

    at.post('/api/ussd', async (req, reply) => {
      if (!allowed(req)) return reply.code(403).send({ error: 'forbidden' });
      if (callbacks.take(`ussd:${req.ip}`)) return reply.code(429).send({ error: 'rate_limited' });
      const b = UssdBody.safeParse(req.body);
      reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store');
      if (!b.success) return reply.code(400).send('END Requete invalide.');
      return ussdReply(
        { db: s.db, piiKey: s.piiKey, clock: s.clock, testFunds: s.money.testFunds === true },
        b.data,
      );
    });

    at.post('/api/sms/delivery', async (req, reply) => {
      if (!allowed(req)) return reply.code(403).send({ error: 'forbidden' });
      if (callbacks.take(`dlr:${req.ip}`)) return reply.code(429).send({ error: 'rate_limited' });
      const b = DeliveryBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'bad_request' });
      return { ok: true, known: recordDelivery(s.db, b.data) };
    });
  });
}
