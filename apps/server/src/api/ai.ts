/**
 * The two AI features (docs/BRIEF.md §11): the latest sea bulletin, and the rules explainer.
 * GET /api/rules always works (the rules as data); POST /api/explain needs a model (503 without).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { latestBulletin } from '../ai/bulletin.js';
import { currentRules, Explainer } from '../ai/explainer.js';
import { errorMessage } from '../lib/log.js';
import { RateLimiter } from '../lib/ratelimit.js';
import type { Services } from '../services.js';

const ExplainBody = z
  .object({
    question: z.string().trim().min(3).max(300),
    lang: z.enum(['fr', 'en']).default('fr'),
  })
  .strict();

export function registerAiRoutes(app: FastifyInstance, s: Services): void {
  const explainer = s.textModel ? new Explainer(s.textModel) : null;
  const perIp = new RateLimiter(8, 60_000);
  // a ceiling on model calls for the whole server, whoever asks
  const global = new RateLimiter(300, 24 * 3600_000);
  const rules = () =>
    currentRules(s.db, {
      settings: s.settings(),
      pricing: s.pricing,
      money: s.wallet.simulated ? 'simulated' : s.money.testFunds ? 'test' : 'real',
    });

  app.get('/api/rules', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return {
      rules: rules(),
      explainer: explainer ? { provider: s.textModel!.provider, model: s.textModel!.model } : null,
    };
  });

  app.get('/api/bulletin', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    const b = latestBulletin(s.db);
    if (!b) return { bulletin: null };
    return {
      bulletin: {
        date: b.date,
        text: b.text,
        source: b.source,
        model: b.model,
        nostrId: b.nostrId,
        publishedAt: b.publishedAt,
      },
    };
  });

  app.post('/api/explain', { bodyLimit: 2048 }, async (req, reply) => {
    if (!explainer) return reply.code(503).send({ error: 'no_model' });
    const body = ExplainBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_question' });
    const wait = perIp.take(`explain:${req.ip}`) || global.take('explain');
    if (wait)
      return reply.code(429).header('retry-after', String(wait)).send({ error: 'rate_limited' });
    try {
      return await explainer.explain(rules(), body.data.question, body.data.lang);
    } catch (err) {
      s.log.warn('explain failed', { error: errorMessage(err) });
      return reply.code(502).send({ error: 'model_failed' });
    }
  });
}
