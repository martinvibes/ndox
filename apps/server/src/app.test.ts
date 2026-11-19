import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('app', () => {
  it('answers /healthz', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('serves the web app with an SPA fallback, but 404s unknown API routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndox-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ndox</title>');
    const app = await buildApp({ webDir: dir });
    const page = await app.inject({ method: 'GET', url: '/verifier/abc' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Ndox</title>');
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
  });
});
