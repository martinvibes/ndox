/**
 * What a crew may see about itself (docs/BRIEF.md §10.4 `/e/:code`, §8 USSD): its pseudonym, its
 * cover and its last payouts. Looked up by the 6-character status code (status page) or by the
 * phone number the operator passes (USSD). Never returns PII: no phone, no Lightning address.
 */
import { getSite } from '@ndox/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { attestations, crews, payouts, policies } from '../db/schema.js';
import { policyStatusAt, type PolicyState } from '../pool/policies.js';
import { crewSecretsFromRow, STATUS_CODE_RE } from '../pool/crews.js';

type CrewRow = typeof crews.$inferSelect;

export interface CrewPayout {
  /** Day of the danger attestation (YYYY-MM-DD). */
  date: string;
  eventId: string;
  amountFcfa: number;
  amountSat: number;
  status: 'pending' | 'paying' | 'paid' | 'failed';
  paidAt: string | null;
  decisiveM: number | null;
  simulated: boolean;
}

export interface CrewStatus {
  code: string;
  pseudonym: string;
  site: string;
  siteName: string;
  demo: boolean;
  active: boolean;
  cover: {
    state: PolicyState | 'none';
    activeFrom: string | null;
    activeUntil: string | null;
    payoutFcfa: number | null;
  };
  payouts: CrewPayout[];
}

/** Most useful policy to show: covered now, then waiting, then awaiting premium, then the latest. */
const RANK: Record<PolicyState, number> = {
  covered: 0,
  waiting: 1,
  awaiting_premium: 2,
  expired: 3,
  cancelled: 4,
};

export function normaliseStatusCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return STATUS_CODE_RE.test(code) ? code : null;
}

export function crewStatus(db: Db, crew: CrewRow, now: Date, payoutLimit = 5): CrewStatus {
  const rows = db
    .select()
    .from(policies)
    .where(eq(policies.crewId, crew.id))
    .orderBy(desc(policies.createdAt))
    .all();
  const best = rows
    .map((p) => ({ p, state: policyStatusAt(p, now) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state])[0];

  const paid = db
    .select({ p: payouts, decisiveM: attestations.decisiveM, date: attestations.date })
    .from(payouts)
    .innerJoin(policies, eq(policies.id, payouts.policyId))
    .innerJoin(attestations, eq(attestations.eventId, payouts.attestationId))
    .where(and(eq(policies.crewId, crew.id), eq(payouts.replay, false)))
    .orderBy(desc(payouts.createdAt))
    .limit(payoutLimit)
    .all();

  return {
    code: crew.statusCode,
    pseudonym: crew.pseudonym,
    site: crew.site,
    siteName: getSite(crew.site)?.name ?? crew.site,
    demo: crew.demo,
    active: crew.active,
    cover: best
      ? {
          state: best.state,
          activeFrom: best.p.activeFrom,
          activeUntil: best.p.activeUntil,
          payoutFcfa: best.p.payoutFcfa,
        }
      : { state: 'none', activeFrom: null, activeUntil: null, payoutFcfa: null },
    payouts: paid.map(({ p, decisiveM, date }) => ({
      date,
      eventId: p.attestationId,
      amountFcfa: p.amountFcfa,
      amountSat: p.amountSat,
      status: p.status,
      paidAt: p.paidAt,
      decisiveM,
      simulated: p.wallet === 'fake',
    })),
  };
}

export function crewByCode(db: Db, code: string): CrewRow | undefined {
  const c = normaliseStatusCode(code);
  return c ? db.select().from(crews).where(eq(crews.statusCode, c)).get() : undefined;
}

/**
 * Finds the active crew enrolled with this phone number. Phones are sealed with a random nonce, so
 * this opens each one: fine for a few thousand crews, and nothing is kept in memory or logged.
 */
export function crewByPhone(db: Db, piiKey: Buffer, phone: string): CrewRow | undefined {
  const wanted = phone.replace(/[\s-]/g, '');
  if (!/^\+[1-9][0-9]{7,14}$/.test(wanted)) return undefined;
  const rows = db
    .select()
    .from(crews)
    .where(and(eq(crews.active, true), isNotNull(crews.phoneEnc)))
    .all();
  return rows.find((r) => {
    try {
      return crewSecretsFromRow(r, piiKey).phone === wanted;
    } catch {
      return false;
    }
  });
}
