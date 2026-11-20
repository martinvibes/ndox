import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { constants as zlib } from 'node:zlib';
import type { Logger } from 'pino';
import { registerAdminRoutes } from './api/admin.js';
import { registerAiRoutes } from './api/ai.js';
import { registerCrewRoutes } from './api/crew.js';
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

  // JSON answers (the backtest is ~40 KB) travel compressed over slow mobile links. Static files
  // are compressed at build time and already carry their content-encoding, so they pass through.
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } },
  });

  app.get('/healthz', async () => ({ ok: true }));

  if (opts.services) {
    registerPublicRoutes(app, opts.services);
    registerMoneyRoutes(app, opts.services);
    registerAdminRoutes(app, opts.services);
    registerCrewRoutes(app, opts.services);
    registerAiRoutes(app, opts.services);
  }

  const webDir =
    opts.webDir && existsSync(resolve(opts.webDir, 'index.html'))
      ? resolve(opts.webDir)
      : undefined;
  // Vite fingerprints everything under /assets: cache it for good. The shell, the service worker
  // and the manifest must revalidate, or a deploy never reaches installed phones.
  if (webDir)
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      // apps/web/scripts/compress.mjs writes .br/.gz next to each text asset at build time.
      preCompressed: true,
      cacheControl: false,
      setHeaders: (reply, path) => {
        reply.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: unknown GET routes outside /api serve index.html
    if (webDir && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
