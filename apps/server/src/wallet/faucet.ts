/**
 * Alby's NWC faucet (https://faucet.nwc.dev, github.com/getAlby/nwc-faucet): test sub-wallets whose
 * balances "are not real and exist only inside the NWC Faucet". Used only on NETWORK_LABEL=test to
 * give each demo crew a Lightning address that really receives its (test) payout.
 *
 * `POST /?balance=<sat>` answers with a plain-text NWC connection string whose `lud16` parameter is
 * the new wallet's Lightning address. We keep the address and drop the connection string: Ndox
 * never needs to spend from a crew's wallet. Nothing here is logged.
 */
export interface TestFaucet {
  /** Creates a test wallet and returns its Lightning address. */
  createWallet(balanceSat?: number): Promise<{ lightningAddress: string }>;
}

export class FaucetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaucetError';
  }
}

const LUD16 = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

/** The `lud16` of an NWC connection string, or null. */
export function lud16Of(nwcUrl: string): string | null {
  if (!nwcUrl.startsWith('nostr+walletconnect://')) return null;
  const q = nwcUrl.indexOf('?');
  if (q < 0) return null;
  const v = new URLSearchParams(nwcUrl.slice(q + 1)).get('lud16')?.trim().toLowerCase();
  return v && LUD16.test(v) ? v : null;
}

export class NwcFaucet implements TestFaucet {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** The public faucet sometimes answers 5xx: try this many times (1 s, 2 s, 4 s … apart). */
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.attempts = o.attempts ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async createWallet(balanceSat = 0): Promise<{ lightningAddress: string }> {
    if (!Number.isSafeInteger(balanceSat) || balanceSat < 0)
      throw new RangeError('balanceSat must be a non-negative integer');
    let last: FaucetError = new FaucetError('test faucet unreachable');
    for (let i = 0; i < this.attempts; i++) {
      if (i > 0) await this.sleep(1000 * 2 ** (i - 1));
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/?balance=${balanceSat}`, {
          method: 'POST',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        last = new FaucetError('test faucet unreachable');
        continue;
      }
      if (!res.ok) {
        last = new FaucetError(`test faucet answered ${res.status}`);
        if (res.status >= 500 || res.status === 429) continue;
        throw last;
      }
      const lightningAddress = lud16Of((await res.text()).trim());
      if (!lightningAddress) throw new FaucetError('test faucet returned no Lightning address');
      return { lightningAddress };
    }
    throw last;
  }
}
