import { describe, expect, it } from 'vitest';
import { FaucetError, lud16Of, NwcFaucet } from './faucet.js';

const URL_WITH_LUD16 =
  'nostr+walletconnect://85ce8c24?relay=wss://relay.getalby.com&secret=abc&lud16=nwc1795176971165@getalby.com';

describe('NWC faucet', () => {
  it('reads the Lightning address out of a connection string', () => {
    expect(lud16Of(URL_WITH_LUD16)).toBe('nwc1795176971165@getalby.com');
    expect(lud16Of('nostr+walletconnect://abc?secret=1')).toBeNull();
    expect(lud16Of('nostr+walletconnect://abc?lud16=not-an-address')).toBeNull();
    expect(lud16Of('https://example.com/?lud16=a@b.co')).toBeNull();
  });

  it('creates a wallet with POST /?balance= and keeps only its address', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const faucet = new NwcFaucet({
      baseUrl: 'https://faucet.example/',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return new Response(`${URL_WITH_LUD16}\n`);
      }) as typeof fetch,
    });
    expect(await faucet.createWallet()).toEqual({
      lightningAddress: 'nwc1795176971165@getalby.com',
    });
    expect(calls).toEqual([{ url: 'https://faucet.example/?balance=0', method: 'POST' }]);
  });

  it('fails clearly, without echoing the response, when the faucet misbehaves', async () => {
    const answer = (body: string, status = 200) =>
      new NwcFaucet({
        baseUrl: 'https://faucet.example',
        fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
      });
    await expect(answer('nope', 500).createWallet()).rejects.toThrow('test faucet answered 500');
    const err = await answer('nostr+walletconnect://x?secret=s3cr3t')
      .createWallet()
      .catch((e) => e);
    expect(err).toBeInstanceOf(FaucetError);
    expect(String(err)).not.toContain('s3cr3t');
    const down = new NwcFaucet({
      baseUrl: 'https://faucet.example',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(down.createWallet()).rejects.toThrow('test faucet unreachable');
    await expect(down.createWallet(-1)).rejects.toThrow(RangeError);
  });
});
