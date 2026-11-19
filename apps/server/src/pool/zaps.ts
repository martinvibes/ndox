/**
 * Zaps to the pool (docs/BRIEF.md §7.3, NIP-57): sponsors zap the pool's Nostr profile, whose
 * `lud16` is POOL_LIGHTNING_ADDRESS. The pool's wallet must be the one behind that address
 * (e.g. Alby Hub): a zap counts as a top-up only when our own wallet confirms it received that
 * exact invoice. Receipts are also checked as NIP-57 Appendix F says (signed by the address's
 * LNURL server `nostrPubkey`, amount equal to the zap request's), which filters noise, but the
 * wallet lookup is what makes it money.
 *
 * Privacy: the sender's pubkey and the zap comment are neither stored nor logged.
 */
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from '@ndox/oracle';
import { satToFcfa } from '@ndox/shared';
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { SimplePool } from 'nostr-tools/pool';
import { deposits, payouts, settings } from '../db/schema.js';
import { errorMessage } from '../lib/log.js';
import { isoSeconds, unixSeconds } from '../lib/time.js';
import { dueForRetry, type PublishResult } from '../nostr/publisher.js';
import { preimageMatches } from '../wallet/nwc.js';
import type { MoneyCtx } from './deposits.js';

export const KIND_ZAP_REQUEST = 9734;
export const KIND_ZAP_RECEIPT = 9735;
/** Relays can be late: each query looks back this far before the last receipt handled. */
const OVERLAP_SEC = 3600;
const FIRST_LOOKBACK_SEC = 7 * 86_400;
const CURSOR_KEY = 'zaps.cursor';
const PROFILE_KEY = 'pool.profile';

export interface ZapSource {
  receipts(poolPubkey: string, since: number): Promise<NostrEvent[]>;
  close?(): void;
}

interface QueryPool {
  querySync(
    relays: string[],
    filter: { kinds: number[]; '#p': string[]; since: number; limit: number },
    params?: { maxWait?: number },
  ): Promise<NostrEvent[]>;
  close(relays: string[]): void;
}

export class RelayZapSource implements ZapSource {
  private readonly pool: QueryPool;

  constructor(
    private readonly relays: string[],
    pool?: QueryPool,
  ) {
    this.pool = pool ?? (new SimplePool() as unknown as QueryPool);
  }

  receipts(poolPubkey: string, since: number): Promise<NostrEvent[]> {
    return this.pool.querySync(
      this.relays,
      { kinds: [KIND_ZAP_RECEIPT], '#p': [poolPubkey], since, limit: 500 },
      { maxWait: 10_000 },
    );
  }

  close(): void {
    this.pool.close(this.relays);
  }
}

/** LUD-16 + NIP-57: the key the address's LNURL server signs zap receipts with. */
export async function fetchZapperPubkey(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const [user, domain] = address.split('@');
  const res = await fetchImpl(`https://${domain}/.well-known/lnurlp/${user}`, {
    headers: { accept: 'application/json', 'user-agent': 'ndox-oracle/0.1' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`LNURL server answered ${res.status}`);
  const body = (await res.json()) as { allowsNostr?: unknown; nostrPubkey?: unknown };
  if (body.allowsNostr !== true || typeof body.nostrPubkey !== 'string')
    throw new Error('the pool Lightning address does not support zaps (allowsNostr)');
  if (!/^[0-9a-f]{64}$/.test(body.nostrPubkey)) throw new Error('invalid nostrPubkey');
  return body.nostrPubkey;
}

const tag = (ev: NostrEvent, name: string) => ev.tags.find((t) => t[0] === name)?.[1];

export type ZapCheck =
  | { ok: true; paymentHash: string; amountMsat: number; paidAt: number }
  | { ok: false; reason: string };

/** NIP-57 Appendix F, plus the checks that make a receipt usable at all. */
export function checkZapReceipt(
  ev: NostrEvent,
  o: { poolPubkey: string; zapperPubkey: string },
): ZapCheck {
  const no = (reason: string): ZapCheck => ({ ok: false, reason });
  if (ev.kind !== KIND_ZAP_RECEIPT) return no('not a zap receipt');
  if (!verifyEvent(ev)) return no('bad receipt signature');
  if (ev.pubkey !== o.zapperPubkey) return no('receipt not signed by the LNURL server');
  if (!ev.tags.some((t) => t[0] === 'p' && t[1] === o.poolPubkey)) return no('not for the pool');
  const bolt11 = tag(ev, 'bolt11');
  const inv = bolt11 ? decodeInvoice(bolt11) : null;
  if (!inv || !/^[0-9a-f]{64}$/.test(inv.paymentHash)) return no('missing or invalid bolt11');
  if (!(inv.millisatoshi > 0)) return no('zero-amount invoice');
  const preimage = tag(ev, 'preimage');
  if (preimage !== undefined && !preimageMatches(preimage, inv.paymentHash))
    return no('preimage does not match');

  let req: NostrEvent;
  try {
    req = JSON.parse(tag(ev, 'description') ?? '') as NostrEvent;
  } catch {
    return no('missing zap request');
  }
  if (req?.kind !== KIND_ZAP_REQUEST || !Array.isArray(req.tags) || !verifyEvent(req))
    return no('invalid zap request');
  if (!req.tags.some((t) => t[0] === 'p' && t[1] === o.poolPubkey))
    return no('zap request not for the pool');
  const amount = tag(req, 'amount');
  if (amount !== undefined && Number(amount) !== inv.millisatoshi)
    return no('invoice amount differs from the zap request');
  return {
    ok: true,
    paymentHash: inv.paymentHash,
    amountMsat: inv.millisatoshi,
    paidAt: ev.created_at,
  };
}

export interface ZapResult {
  seen: number;
  recorded: number;
  rejected: number;
  /** Still pending in our wallet, or the lookup failed: looked at again next time. */
  deferred: number;
}

export interface ZapWatcherOptions {
  source: ZapSource;
  /** POOL_LIGHTNING_ADDRESS. */
  address: string;
  /** Resolves the LNURL server's nostrPubkey (cached for an hour). */
  zapperPubkey?: () => Promise<string>;
  intervalMs?: number;
}

/** Polls relays for zap receipts every few minutes and records confirmed ones as deposits. */
export class ZapWatcher {
  private last = 0;
  private zapper: { key: string; at: number } | null = null;
  private readonly interval: number;

  constructor(private readonly o: ZapWatcherOptions) {
    this.interval = o.intervalMs ?? 5 * 60_000;
  }

  get address(): string {
    return this.o.address;
  }

  private async zapperPubkey(now: number): Promise<string> {
    if (this.zapper && now - this.zapper.at < 3600_000) return this.zapper.key;
    const key = await (this.o.zapperPubkey ?? (() => fetchZapperPubkey(this.o.address)))();
    this.zapper = { key, at: now };
    return key;
  }

  /** null when not due yet. */
  async run(ctx: MoneyCtx, force = false): Promise<ZapResult | null> {
    const now = ctx.clock();
    if (!force && now.getTime() - this.last < this.interval) return null;
    this.last = now.getTime();
    return ingestZaps(ctx, this.o.source, await this.zapperPubkey(now.getTime()));
  }

  close(): void {
    this.o.source.close?.();
  }
}

export async function ingestZaps(
  ctx: MoneyCtx,
  source: ZapSource,
  zapperPubkey: string,
): Promise<ZapResult> {
  const { db } = ctx;
  const now = ctx.clock();
  const poolPubkey = getPublicKey(ctx.poolSecret);
  const stored = db.select().from(settings).where(eq(settings.key, CURSOR_KEY)).get()?.value as
    { since?: number } | undefined;
  const cursor = stored?.since ?? unixSeconds(now) - FIRST_LOOKBACK_SEC;
  const events = await source.receipts(poolPubkey, Math.max(0, cursor - OVERLAP_SEC));

  const result: ZapResult = { seen: events.length, recorded: 0, rejected: 0, deferred: 0 };
  let newest = cursor;
  let oldestDeferred = Infinity;
  let price: { xofPerBtc: number } | null = null;

  for (const ev of [...events].sort((a, b) => a.created_at - b.created_at)) {
    if (db.select({ id: deposits.id }).from(deposits).where(eq(deposits.zapReceiptId, ev.id)).get())
      continue;
    const c = checkZapReceipt(ev, { poolPubkey, zapperPubkey });
    if (!c.ok) {
      result.rejected++;
      ctx.log.info('zap receipt ignored', { receipt: ev.id, reason: c.reason });
      newest = Math.max(newest, Math.min(ev.created_at, unixSeconds(now)));
      continue;
    }
    // ours already (an invoice we issued, or a payment we made): never a zap
    const known =
      db
        .select({ id: deposits.id })
        .from(deposits)
        .where(eq(deposits.paymentHash, c.paymentHash))
        .get() ??
      db
        .select({ id: payouts.id })
        .from(payouts)
        .where(eq(payouts.paymentHash, c.paymentHash))
        .get();
    if (known) {
      result.rejected++;
      continue;
    }

    let look;
    try {
      look = await ctx.wallet.lookupInvoice(c.paymentHash);
    } catch (err) {
      ctx.log.warn('zap lookup failed', { receipt: ev.id, error: errorMessage(err) });
      result.deferred++;
      oldestDeferred = Math.min(oldestDeferred, ev.created_at);
      continue;
    }
    if (look.state === 'pending' && look.direction !== 'outgoing') {
      result.deferred++;
      oldestDeferred = Math.min(oldestDeferred, ev.created_at);
      continue;
    }
    if (look.state !== 'settled' || look.direction !== 'incoming') {
      // not money our wallet received (another wallet's invoice, or a payment we made)
      result.rejected++;
      ctx.log.info('zap receipt ignored', { receipt: ev.id, reason: 'not received by the pool' });
      newest = Math.max(newest, Math.min(ev.created_at, unixSeconds(now)));
      continue;
    }
    const amountSat = look.amountSat ?? Math.floor(c.amountMsat / 1000);
    if (amountSat !== Math.floor(c.amountMsat / 1000)) {
      result.rejected++;
      ctx.log.warn('zap amount differs from the wallet', { receipt: ev.id });
      continue;
    }
    if (!price) price = await ctx.prices.get().catch(() => null);
    const paidAt = new Date(Math.min(c.paidAt, unixSeconds(now)) * 1000);
    const inserted = db
      .insert(deposits)
      .values({
        id: `d${randomBytes(6).toString('hex')}`,
        kind: 'zap',
        status: 'paid',
        amountSat,
        amountFcfa: price ? satToFcfa(amountSat, price.xofPerBtc) : null,
        xofPerBtc: price?.xofPerBtc ?? null,
        paymentHash: c.paymentHash,
        zapReceiptId: ev.id,
        memo: 'Zap (NIP-57)',
        wallet: ctx.wallet.kind,
        demo: ctx.wallet.simulated,
        createdAt: isoSeconds(now),
        paidAt: isoSeconds(paidAt),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 1) {
      result.recorded++;
      ctx.log.info('zap received', { receipt: ev.id, sat: amountSat });
    }
    newest = Math.max(newest, Math.min(ev.created_at, unixSeconds(now)));
  }

  const since = Number.isFinite(oldestDeferred) ? Math.min(newest, oldestDeferred) : newest;
  db.insert(settings)
    .values({ key: CURSOR_KEY, value: { since } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { since }, updatedAt: isoSeconds(now) },
    })
    .run();
  return result;
}

/**
 * The pool's Nostr profile (kind 0): what sponsors zap. Signed by POOL_SECRET, re-published
 * when its content changes, or after a failed publish.
 */
export async function publishPoolProfile(
  ctx: MoneyCtx,
  o: { lud16: string | undefined; website: string },
): Promise<boolean> {
  if (!ctx.publisher) return false;
  const content = JSON.stringify({
    name: 'Ndox · Caisse commune',
    about:
      'Solidarité préventive pour les pêcheurs artisanaux du Sénégal : les jours de mer dangereuse, ' +
      'la caisse paie chaque équipage couvert. Les zaps vont à la caisse. Données publiques et vérifiables.',
    website: o.website,
    ...(o.lud16 ? { lud16: o.lud16 } : {}),
  });
  const hash = createHash('sha256').update(content).digest('hex');
  const row = ctx.db.select().from(settings).where(eq(settings.key, PROFILE_KEY)).get();
  const prev = row?.value as
    | { hash: string; eventJson: string; publishResult: PublishResult | null; ok: boolean }
    | undefined;
  const now = ctx.clock();
  if (prev?.hash === hash && (prev.ok || !dueForRetry(prev.publishResult, now))) return false;

  const ev =
    prev?.hash === hash
      ? (JSON.parse(prev.eventJson) as NostrEvent)
      : finalizeEvent({ kind: 0, created_at: unixSeconds(now), tags: [], content }, ctx.poolSecret);
  let res: PublishResult;
  try {
    res = await ctx.publisher.publish(ev);
  } catch (err) {
    res = {
      ok: false,
      accepted: [],
      rejected: [{ relay: '*', reason: errorMessage(err) }],
      at: '',
    };
  }
  const value = {
    hash,
    eventJson: JSON.stringify(ev),
    publishResult: { ...res, at: isoSeconds(now) },
    ok: res.ok,
  };
  ctx.db
    .insert(settings)
    .values({ key: PROFILE_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: isoSeconds(now) } })
    .run();
  if (!res.ok) ctx.log.warn('pool profile publish failed', { accepted: res.accepted.length });
  return res.ok;
}
