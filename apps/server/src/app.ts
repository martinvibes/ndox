import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AppOptions {
  /** Directory holding the built web app (index.html + assets). */
  webDir?: string | undefined;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/healthz', async () => ({ ok: true }));

  const webDir = opts.webDir;
  if (webDir && existsSync(resolve(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: resolve(webDir), wildcard: false });
    // SPA fallback: unknown GET routes outside /api serve index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
