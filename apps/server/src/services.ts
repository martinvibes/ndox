/** Wires configuration, database and adapters into the objects the API, scheduler and CLI use. */
import { getPublicKey } from '@ndox/oracle';
import { join } from 'node:path';
import type { BulletinCtx } from './ai/bulletin.js';
import { createTextModel, type TextModel } from './ai/model.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { deriveKey } from './lib/box.js';
import type { Log } from './lib/log.js';
import type { NotifyCtx } from './notify/jobs.js';
import { AfricasTalkingSms, ConsoleNotifier, type Notifier } from './notify/sms.js';
import { systemClock, type Clock } from './lib/time.js';
import { PriceService } from './money/price.js';
import { RelayPublisher, type Publisher } from './nostr/publisher.js';
import type { OracleCtx } from './oracle/jobs.js';
import type { ReplayDeps } from './oracle/replay.js';
import type { PayoutCtx } from './payouts/engine.js';
import type { ReplayPayoutOptions } from './payouts/replay.js';
import { RelayZapSource, ZapWatcher, type ZapSource } from './pool/zaps.js';
import { Pricing } from './pool/pricing.js';
import { getPolicySettings, policyDefaults, type PolicySettings } from './pool/settings.js';
import { FakeLnAddressResolver, FakeWallet } from './wallet/fake.js';
import { LnurlResolver } from './wallet/lnaddress.js';
import { NwcFaucet, type TestFaucet } from './wallet/faucet.js';
import { NwcWallet } from './wallet/nwc.js';
import type { LnAddressResolver, Wallet } from './wallet/types.js';
import { OutlookService } from './wave/outlook.js';
import { ChainSource, OpenMeteoSource, SeedSource, type ForecastSource } from './wave/source.js';

export interface Services {
  config: Config;
  db: Db;
  log: Log;
  clock: Clock;
  /** null when NOSTR_PUBLISH=false (sign and store, do not publish). */
  publisher: Publisher | null;
  /** Live oracle context (ORACLE_SECRET, `ndox` tag). */
  live: OracleCtx;
  /** Replay dependencies (DEMO_ORACLE_SECRET, seed data first, never published by default). */
  replay: ReplayDeps;
  outlook: OutlookService;
  prices: PriceService;
  pricing: Pricing;
  /** The pool wallet: FakeWallet ("Simulé") or NWC. */
  wallet: Wallet;
  /**
   * NETWORK_LABEL=test only: creates test wallets so demo crews get Lightning addresses that
   * really receive their (test) payouts. null otherwise.
   */
  faucet: TestFaucet | null;
  /** Live money context: deposits, policies, payouts (POOL_SECRET). */
  money: PayoutCtx;
  /** SMS to crews: console (default) or Africa's Talking when AT_API_KEY is set. */
  notifier: Notifier;
  /** Context of the `notify` job (SMS after each paid payout). */
  notify: NotifyCtx;
  /** Anthropic, else OpenAI, else null (bulletin and explainer then use templates / rules). */
  textModel: TextModel | null;
  /** Context of the daily sea bulletin job. */
  bulletin: BulletinCtx;
  /** What a replay needs to pay demo crews from a simulated wallet. */
  replayPayouts: ReplayPayoutOptions;
  piiKey: Buffer;
  policyDefaults: PolicySettings;
  settings(): PolicySettings;
  close(): void;
}

export interface ServiceOverrides {
  clock?: Clock;
  liveSource?: ForecastSource;
  publisher?: Publisher | null;
  wallet?: Wallet;
  resolver?: LnAddressResolver;
  priceFetch?: typeof fetch;
  zapSource?: ZapSource;
  zapperPubkey?: () => Promise<string>;
  testFunds?: boolean;
  testPayer?: Wallet | null;
  faucet?: TestFaucet | null;
  notifier?: Notifier;
  textModel?: TextModel | null;
}

export function createServices(
  config: Config,
  db: Db,
  log: Log,
  o: ServiceOverrides = {},
): Services {
  const clock = o.clock ?? systemClock;
  const http = o.liveSource ?? new OpenMeteoSource();
  const publisher =
    o.publisher !== undefined
      ? o.publisher
      : config.nostrPublish
        ? new RelayPublisher(config.relays)
        : null;
  const live: OracleCtx = {
    db,
    secret: config.secrets.oracle,
    nonceKey: deriveKey(config.secrets.oracle, 'nonce'),
    source: http,
    publisher,
    relays: config.relays,
    clock,
    log,
  };
  const replay: ReplayDeps = {
    db,
    demoSecret: config.secrets.demoOracle,
    source: new ChainSource([new SeedSource(config.seedDir), http]),
    publisher: null,
    relays: config.relays,
    log,
    now: clock,
  };

  // FakeWallet keys derive from the pool secret: stable across restarts, never stored.
  const fakeSeed = deriveKey(config.secrets.pool, 'fake-wallet').toString('hex');
  const wallet: Wallet =
    o.wallet ??
    (config.walletMode === 'nwc'
      ? new NwcWallet({ url: config.nwcUrl, clock })
      : new FakeWallet({ db, seed: fakeSeed, account: 'pool', clock }));
  const resolver: LnAddressResolver =
    o.resolver ??
    (config.walletMode === 'nwc'
      ? new LnurlResolver()
      : new FakeLnAddressResolver({ db, seed: fakeSeed, clock }));
  const prices = new PriceService({
    db,
    clock,
    seedFile: join(config.seedDir, 'price.json'),
    ...(o.priceFetch ? { fetchImpl: o.priceFetch } : {}),
  });
  const pricing = Pricing.load(config.seedDir);
  const defaults = policyDefaults(config);
  const settings = () => getPolicySettings(db, defaults);
  const piiKey = deriveKey(config.secrets.pii, 'pii');
  // test networks only (config refuses a test payer on mainnet): sats without value
  const testFunds = o.testFunds ?? config.testFunds;
  const testPayer: Wallet | null =
    o.testPayer !== undefined
      ? o.testPayer
      : config.testPayerNwcUrl
        ? new NwcWallet({ url: config.testPayerNwcUrl, clock })
        : null;
  const faucet: TestFaucet | null =
    o.faucet !== undefined
      ? o.faucet
      : testFunds && config.network === 'test'
        ? new NwcFaucet({ baseUrl: config.testFaucetUrl })
        : null;
  // zaps count only when a real wallet can confirm them (it serves POOL_LIGHTNING_ADDRESS)
  const zaps =
    config.poolLightningAddress && !wallet.simulated
      ? new ZapWatcher({
          source: o.zapSource ?? new RelayZapSource(config.relays),
          address: config.poolLightningAddress,
          ...(o.zapperPubkey ? { zapperPubkey: o.zapperPubkey } : {}),
        })
      : null;
  const money: PayoutCtx = {
    db,
    wallet,
    prices,
    clock,
    poolSecret: config.secrets.pool,
    publisher,
    relays: config.relays,
    pricing,
    settings,
    log,
    piiKey,
    resolver,
    oraclePubkey: getPublicKey(config.secrets.oracle),
    zaps,
    profile: { lud16: config.poolLightningAddress, website: config.publicBaseUrl },
    testFunds,
    testPayer: testFunds ? testPayer : null,
  };

  const notifier: Notifier =
    o.notifier ??
    (config.africasTalking.apiKey
      ? new AfricasTalkingSms({
          username: config.africasTalking.username,
          apiKey: config.africasTalking.apiKey,
        })
      : new ConsoleNotifier(log));
  const notify: NotifyCtx = { db, piiKey, notifier, clock, log, testFunds };
  const textModel = o.textModel !== undefined ? o.textModel : createTextModel(config);
  const bulletin: BulletinCtx = {
    db,
    clock,
    log,
    model: textModel,
    publisher,
    poolSecret: config.secrets.pool,
    publicBaseUrl: config.publicBaseUrl,
    testFunds,
  };

  return {
    config,
    db,
    log,
    clock,
    publisher,
    live,
    replay,
    outlook: new OutlookService(http, clock),
    prices,
    pricing,
    wallet,
    faucet,
    money,
    notifier,
    notify,
    textModel,
    bulletin,
    replayPayouts: { fakeSeed, demoOraclePubkey: getPublicKey(config.secrets.demoOracle) },
    piiKey,
    policyDefaults: defaults,
    settings,
    close() {
      publisher?.close?.();
      zaps?.close();
      wallet.close?.();
      testPayer?.close?.();
      db.$client.close();
    },
  };
}
