/**
 * `notify` (docs/BRIEF.md §3, 05:30): one SMS per paid payout to the crew's phone, if it gave one.
 * Idempotent: the notifications row (unique per crew × attestation × channel) is written before
 * sending, so a re-run never texts twice for a sent message; a failed send is retried up to
 * MAX_ATTEMPTS times on later ticks. Only live payouts: replays never text anyone.
 */
import { getSite } from '@ndox/shared';
import { and, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { attestations, crews, notifications, payouts, policies } from '../db/schema.js';
import { errorMessage, type Log } from '../lib/log.js';
import type { Clock } from '../lib/time.js';
import { isoSeconds } from '../lib/time.js';
import { crewSecretsFromRow } from '../pool/crews.js';
import { payoutSms, phoneHint, type Notifier } from './sms.js';

export const MAX_ATTEMPTS = 3;
/** A payout older than this is not texted (e.g. a phone added weeks later). */
export const NOTIFY_WINDOW_MS = 36 * 3600_000;

export interface NotifyCtx {
  db: Db;
  piiKey: Buffer;
  notifier: Notifier;
  clock: Clock;
  log: Log;
  /** Payouts of test sats are labelled TEST in the SMS. */
  testFunds?: boolean;
}

export interface NotifyResult {
  sent: number;
  failed: number;
}

export async function notifyPayouts(ctx: NotifyCtx): Promise<NotifyResult> {
  const now = ctx.clock();
  const since = isoSeconds(new Date(now.getTime() - NOTIFY_WINDOW_MS));
  const due = ctx.db
    .select({
      payout: payouts,
      crew: crews,
      decisiveM: attestations.decisiveM,
      notif: notifications,
    })
    .from(payouts)
    .innerJoin(policies, eq(policies.id, payouts.policyId))
    .innerJoin(crews, eq(crews.id, policies.crewId))
    .innerJoin(attestations, eq(attestations.eventId, payouts.attestationId))
    .leftJoin(
      notifications,
      and(
        eq(notifications.crewId, crews.id),
        eq(notifications.attestationId, payouts.attestationId),
        eq(notifications.channel, 'sms'),
      ),
    )
    .where(
      and(
        eq(payouts.status, 'paid'),
        eq(payouts.replay, false),
        isNotNull(crews.phoneEnc),
        gte(payouts.paidAt, since),
        or(
          isNull(notifications.id),
          and(eq(notifications.status, 'failed'), lt(notifications.attempts, MAX_ATTEMPTS)),
        ),
      ),
    )
    .all();

  let sent = 0;
  let failed = 0;
  for (const { payout, crew, decisiveM, notif } of due) {
    const phone = crewSecretsFromRow(crew, ctx.piiKey).phone;
    if (!phone) continue;
    const message = payoutSms({
      siteName: getSite(crew.site)?.name ?? crew.site,
      waveM: decisiveM,
      amountFcfa: payout.amountFcfa,
      code: crew.statusCode,
      test: payout.wallet === 'fake' || ctx.testFunds === true,
    });
    // claim the message before sending: a crash after this point never sends it twice
    const row = notif
      ? ctx.db
          .update(notifications)
          .set({ status: 'pending', attempts: notif.attempts + 1, error: null })
          .where(and(eq(notifications.id, notif.id), eq(notifications.status, 'failed')))
          .returning()
          .get()
      : ctx.db
          .insert(notifications)
          .values({
            crewId: crew.id,
            attestationId: payout.attestationId,
            channel: 'sms',
            status: 'pending',
            attempts: 1,
          })
          .onConflictDoNothing()
          .returning()
          .get();
    if (!row) continue; // another tick claimed it
    try {
      const r = await ctx.notifier.send(phone, message);
      ctx.db
        .update(notifications)
        .set({ status: 'sent', providerId: r.providerId, sentAt: isoSeconds(ctx.clock()) })
        .where(eq(notifications.id, row.id))
        .run();
      sent++;
    } catch (err) {
      const error = errorMessage(err).slice(0, 200);
      ctx.db
        .update(notifications)
        .set({ status: 'failed', error })
        .where(eq(notifications.id, row.id))
        .run();
      ctx.log.warn('sms failed', { crew: crew.pseudonym, to: phoneHint(phone), error });
      failed++;
    }
  }
  return { sent, failed };
}

/** Africa's Talking delivery report (POST /api/sms/delivery): updates by provider message id. */
export function recordDelivery(
  db: Db,
  report: { id: string; status: string; failureReason?: string | undefined },
): boolean {
  const failed = /^(Failed|Rejected)$/i.test(report.status);
  const r = db
    .update(notifications)
    .set(
      failed
        ? {
            status: 'failed',
            error: `delivery: ${report.failureReason ?? report.status}`.slice(0, 200),
          }
        : { deliveryStatus: report.status.slice(0, 40) },
    )
    .where(eq(notifications.providerId, report.id))
    .run();
  return r.changes > 0;
}
