import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { registerMoneyRoutes } from './api/money.js';
import { registerPublicRoutes } from './api/public.js';
import type { Services } from './services.js';

export interface AppOptions {
  /** Directory holding the built web app (index.html + assets). */
  webDir?: string | undefined;
  logger?: Logger | false;
  services?: Services;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app: FastifyInstance = opts.logger
    ? Fastify({ loggerInstance: opts.logger as FastifyBaseLogger })
    : Fastify({ logger: false });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    // Never leak internals to clients.
    return reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  if (opts.services) {
    registerPublicRoutes(app, opts.services);
    registerMoneyRoutes(app, opts.services);
  }

  const webDir =
    opts.webDir && existsSync(resolve(opts.webDir, 'index.html'))
      ? resolve(opts.webDir)
      : undefined;
  if (webDir) await app.register(fastifyStatic, { root: webDir, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: unknown GET routes outside /api serve index.html
    if (webDir && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
