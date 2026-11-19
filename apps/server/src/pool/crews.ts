/**
 * Crew enrolment (CLPA dashboard only — no self-enrolment, against ghost crews). The phone number
 * and Lightning address are sealed with PII_ENCRYPTION_KEY (AAD = crew id + field); only a public
 * pseudonym, a 6-character status code and a salted commitment ever leave the server.
 */
import { getSite } from '@ndox/shared';
import { asc, eq, like } from 'drizzle-orm';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/index.js';
import { crews } from '../db/schema.js';
import { open, seal } from '../lib/box.js';

/** No 0/O, 1/I/L: codes are read aloud and typed on feature phones. */
export const STATUS_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const STATUS_CODE_RE = /^[A-Z][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;
/** LUD-16 username characters; a plain domain. */
const LN_ADDRESS_RE = /^[a-z0-9._+-]{1,64}@(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;
const PSEUDONYM_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’.-]{1,38}[\p{L}\p{N}]$/u;

export class CrewInputError extends Error {}

export interface EnrolInput {
  site: string;
  lnAddress: string;
  phone?: string | undefined;
  pseudonym?: string | undefined;
  demo: boolean;
}

export interface CrewView {
  id: string;
  site: string;
  pseudonym: string;
  statusCode: string;
  demo: boolean;
  active: boolean;
  /** "•••@domain" — the domain tells the treasurer which wallet, not who. */
  lnAddressHint: string | null;
  /** Last two digits. */
  phoneHint: string | null;
  createdAt: string;
}

type CrewRow = typeof crews.$inferSelect;

const aad = (id: string, field: 'phone' | 'ln') => `crew:${id}:${field}`;

export function holderCommitment(saltHex: string, crewId: string): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(saltHex, 'hex'), Buffer.from(crewId, 'utf8')]))
    .digest('hex');
}

function newStatusCode(prefix: string): string {
  let s = prefix;
  for (let i = 0; i < 5; i++) s += STATUS_CODE_ALPHABET[randomInt(STATUS_CODE_ALPHABET.length)];
  return s;
}

function hints(row: CrewRow, piiKey: Buffer): Pick<CrewView, 'lnAddressHint' | 'phoneHint'> {
  const s = crewSecretsFromRow(row, piiKey);
  return {
    lnAddressHint: s.lnAddress ? `•••@${s.lnAddress.split('@')[1] ?? ''}` : null,
    phoneHint: s.phone ? `•• ${s.phone.slice(-2)}` : null,
  };
}

export function crewView(row: CrewRow, piiKey: Buffer): CrewView {
  return {
    id: row.id,
    site: row.site,
    pseudonym: row.pseudonym,
    statusCode: row.statusCode,
    demo: row.demo,
    active: row.active,
    ...hints(row, piiKey),
    createdAt: row.createdAt,
  };
}

export function enrolCrew(db: Db, piiKey: Buffer, input: EnrolInput): CrewView {
  const site = getSite(input.site);
  if (!site) throw new CrewInputError(`unknown site ${input.site}`);
  const lnAddress = input.lnAddress.trim().toLowerCase();
  if (!LN_ADDRESS_RE.test(lnAddress)) throw new CrewInputError('invalid Lightning address');
  const phone = input.phone?.replace(/[\s-]/g, '');
  if (phone !== undefined && phone !== '' && !PHONE_RE.test(phone))
    throw new CrewInputError('invalid phone number (international format, e.g. +221…)');
  const pseudonym = input.pseudonym?.trim();
  if (pseudonym !== undefined && pseudonym !== '' && !PSEUDONYM_RE.test(pseudonym))
    throw new CrewInputError('invalid pseudonym (3–40 letters, digits, spaces)');

  const id = `c${randomBytes(6).toString('hex')}`;
  return db.transaction((tx) => {
    let name = pseudonym || '';
    if (!name) {
      const prefix = `Pirogue ${site.codePrefix}-`;
      const n = tx
        .select()
        .from(crews)
        .where(like(crews.pseudonym, `${prefix}%`))
        .all().length;
      name = `${prefix}${String(n + 1).padStart(2, '0')}`;
    }
    if (tx.select().from(crews).where(eq(crews.pseudonym, name)).get())
      throw new CrewInputError('pseudonym already used');
    let code = newStatusCode(site.codePrefix);
    while (tx.select().from(crews).where(eq(crews.statusCode, code)).get())
      code = newStatusCode(site.codePrefix);
    const row = tx
      .insert(crews)
      .values({
        id,
        site: site.id,
        pseudonym: name,
        statusCode: code,
        phoneEnc: phone ? seal(piiKey, phone, aad(id, 'phone')) : null,
        lnAddressEnc: seal(piiKey, lnAddress, aad(id, 'ln')),
        holderSalt: randomBytes(16).toString('hex'),
        demo: input.demo,
      })
      .returning()
      .get();
    return crewView(row, piiKey);
  });
}

export function listCrews(db: Db, piiKey: Buffer): CrewView[] {
  return db
    .select()
    .from(crews)
    .orderBy(asc(crews.createdAt), asc(crews.pseudonym))
    .all()
    .map((r) => crewView(r, piiKey));
}

function crewSecretsFromRow(
  row: CrewRow,
  piiKey: Buffer,
): { lnAddress: string | null; phone: string | null } {
  return {
    lnAddress: row.lnAddressEnc ? open(piiKey, row.lnAddressEnc, aad(row.id, 'ln')) : null,
    phone: row.phoneEnc ? open(piiKey, row.phoneEnc, aad(row.id, 'phone')) : null,
  };
}

/** Decrypts a crew's contact details (payout engine and notifier only; never logged). */
export function crewSecrets(
  db: Db,
  piiKey: Buffer,
  crewId: string,
): { lnAddress: string | null; phone: string | null } {
  const row = db.select().from(crews).where(eq(crews.id, crewId)).get();
  if (!row) throw new CrewInputError('unknown crew');
  return crewSecretsFromRow(row, piiKey);
}
