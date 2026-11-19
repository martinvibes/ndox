import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gunzipSync } from 'node:zlib';
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

  it('caches hashed assets for a year and revalidates the shell and service worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndox-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ndox</title>');
    writeFileSync(join(dir, 'sw.js'), 'self.x = 1;');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export {};');
    const app = await buildApp({ webDir: dir });
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.headers['cache-control']).toBe('no-cache');
    const shell = await app.inject({ method: 'GET', url: '/' });
    expect(shell.headers['cache-control']).toBe('no-cache');
    const fallback = await app.inject({ method: 'GET', url: '/donnees' });
    expect(fallback.headers['cache-control']).toBe('no-cache');
  });

  it('serves build-time brotli files to browsers that accept them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ndox-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ndox</title>');
    writeFileSync(join(dir, 'assets', 'app-abc.js'), 'export const x = 1;'.repeat(100));
    writeFileSync(
      join(dir, 'assets', 'app-abc.js.br'),
      brotliCompressSync('export const x = 1;'.repeat(100)),
    );
    const app = await buildApp({ webDir: dir });
    const br = await app.inject({
      method: 'GET',
      url: '/assets/app-abc.js',
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const plain = await app.inject({ method: 'GET', url: '/assets/app-abc.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toContain('export const x = 1;');
  });

  it('compresses large API answers, not small ones', async () => {
    const app = await buildApp();
    const rows = Array.from({ length: 400 }, (_, i) => ({ season: `s${i}`, dangerDays: i % 30 }));
    app.get('/api/test-big', async () => ({ rows }));
    const big = await app.inject({
      method: 'GET',
      url: '/api/test-big',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(big.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(big.rawPayload).toString('utf8')).rows).toHaveLength(400);
    const small = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(small.headers['content-encoding']).toBeUndefined();
  });
});
