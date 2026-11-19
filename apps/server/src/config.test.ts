import { getPublicKey } from '@ndox/oracle';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const hex = (c: string) => c.repeat(64);

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ndox-config-')), 'ndox.sqlite');
}

describe('loadConfig', () => {
  it('applies defaults and treats blank values as unset', () => {
    const cfg = loadConfig({ DATABASE_PATH: tempDbPath(), PORT: '', NOSTR_PUBLISH: '' });
    expect(cfg.port).toBe(8080);
    expect(cfg.walletMode).toBe('fake');
    expect(cfg.nostrPublish).toBe(false);
    expect(cfg.relays).toEqual(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
    expect(cfg.defaultThresholdM).toBe(2.5);
    expect(cfg.payoutFcfa).toBe(2000);
    expect(cfg.anthropic.model).toBe('claude-haiku-5-5');
    expect(cfg.scheduler).toBe(true);
  });

  it('generates missing secrets once in fake mode and persists them with mode 0600', () => {
    const db = tempDbPath();
    const a = loadConfig({ DATABASE_PATH: db });
    expect(a.generatedSecretsFile).toBe(join(db, '..', 'secrets.json'));
    for (const v of Object.values(a.secrets)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(Object.values(a.secrets)).size).toBe(5);
    expect(statSync(a.generatedSecretsFile as string).mode & 0o777).toBe(0o600);

    const b = loadConfig({ DATABASE_PATH: db });
    expect(b.secrets).toEqual(a.secrets);

    // a provided value wins over the stored one
    const c = loadConfig({ DATABASE_PATH: db, ORACLE_SECRET: hex('7') });
    expect(c.secrets.oracle).toBe(hex('7'));
    expect(c.secrets.pool).toBe(a.secrets.pool);
    const stored = JSON.parse(readFileSync(a.generatedSecretsFile as string, 'utf8')) as Record<
      string,
      string
    >;
    expect(stored.ORACLE_SECRET).toBe(a.secrets.oracle);
  });

  it('does not touch the disk when every secret is provided', () => {
    const cfg = loadConfig({
      DATABASE_PATH: tempDbPath(),
      ORACLE_SECRET: hex('1'),
      DEMO_ORACLE_SECRET: hex('2'),
      POOL_SECRET: hex('3'),
      SESSION_SECRET: hex('4'),
      PII_ENCRYPTION_KEY: hex('5'),
    });
    expect(cfg.generatedSecretsFile).toBeUndefined();
    expect(getPublicKey(cfg.secrets.oracle)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to start in nwc mode without every secret, naming (not printing) them', () => {
    let err: unknown;
    try {
      loadConfig({ DATABASE_PATH: tempDbPath(), WALLET_MODE: 'nwc', ORACLE_SECRET: hex('1') });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain('DEMO_ORACLE_SECRET');
    expect(msg).toContain('NWC_URL');
    expect(msg).toContain('ADMIN_PASSWORD_HASH');
    expect(msg).not.toContain(hex('1'));
  });

  it('rejects shared keys, invalid keys and malformed values', () => {
    const base = { DATABASE_PATH: tempDbPath() };
    expect(() => loadConfig({ ...base, ORACLE_SECRET: hex('1'), POOL_SECRET: hex('1') })).toThrow(
      /must all differ/,
    );
    expect(() => loadConfig({ ...base, ORACLE_SECRET: '0'.repeat(64) })).toThrow(/ORACLE_SECRET/);
    expect(() => loadConfig({ ...base, ORACLE_SECRET: 'AB'.repeat(32) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, NOSTR_RELAYS: 'https://nope' })).toThrow(/relay/);
    expect(() => loadConfig({ ...base, PAYOUT_FCFA: '2000.5' })).toThrow(/PAYOUT_FCFA/);
    expect(() => loadConfig({ ...base, WALLET_MODE: 'real' })).toThrow(/WALLET_MODE/);
  });

  it('parses booleans and relay lists', () => {
    const cfg = loadConfig({
      DATABASE_PATH: tempDbPath(),
      NOSTR_PUBLISH: 'true',
      SCHEDULER: 'off',
      NOSTR_RELAYS: ' wss://a.example , wss://b.example ',
    });
    expect(cfg.nostrPublish).toBe(true);
    expect(cfg.scheduler).toBe(false);
    expect(cfg.relays).toEqual(['wss://a.example', 'wss://b.example']);
  });
});
