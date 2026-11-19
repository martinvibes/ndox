import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const webDir = process.env.WEB_DIST_DIR ?? resolve(here, '../../web/dist');
const port = Number(process.env.PORT ?? 8080);

const app = await buildApp({ webDir, logger: true });
await app.listen({ port, host: '0.0.0.0' });
