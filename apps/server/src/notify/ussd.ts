/**
 * USSD menu (docs/BRIEF.md §8), Africa's Talking callback format: the operator posts the session
 * text so far ("", "1", "2", …, joined with "*") and we answer "CON …" (menu continues) or
 * "END …" (session closes). Answers stay under 182 characters, plain ASCII for feature phones.
 * The caller is recognised by the phone number the operator passes; nothing is logged.
 */
import { SITES } from '@ndox/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sites } from '../db/schema.js';
import { crewByPhone, crewStatus } from '../crew/status.js';
import { getAttestation, SCHEDULE } from '../oracle/jobs.js';
import { isoDate } from '../lib/time.js';
import { fcfaText, gsmSafe, metresText } from './sms.js';

export const USSD_MAX = 182;

export interface UssdCtx {
  db: Db;
  piiKey: Buffer;
  clock: () => Date;
  /** Payouts of test sats are labelled (test). */
  testFunds?: boolean;
}

const MENU = "CON NDOX\n1. Statut de ma couverture\n2. Derniers paiements\n3. Mer aujourd'hui";
const UNKNOWN = 'END Numero non inscrit. Demandez au CLPA de votre quai.';

/** "12/12" */
function dayMonth(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function end(body: string): string {
  return gsmSafe(`END ${body}`).slice(0, USSD_MAX);
}

export function ussdReply(ctx: UssdCtx, input: { phoneNumber: string; text: string }): string {
  const choice = input.text.trim().split('*').filter(Boolean);
  if (choice.length === 0) return MENU;
  const now = ctx.clock();

  if (choice[0] === '3') {
    const date = isoDate(now);
    const enabled = new Set(
      ctx.db
        .select()
        .from(sites)
        .where(eq(sites.enabled, true))
        .all()
        .map((s) => s.id),
    );
    const lines = SITES.filter((s) => enabled.has(s.id)).map((s) => {
      const name = s.name.replace(/\s*\(.*\)\s*$/, '');
      const att = getAttestation(ctx.db, `ndox:${s.id}:${date}`);
      if (!att) return `${name}: resultat a ${SCHEDULE.attest} GMT`;
      const m = att.decisiveM !== null ? ` ${metresText(att.decisiveM)} m` : '';
      if (att.outcome === 'danger') return `${name}: DANGER${m}`;
      if (att.outcome === 'calme') return `${name}: calme${m}`;
      return `${name}: pas de donnees`;
    });
    return end(`Mer ${dayMonth(date)}:\n${lines.join('\n')}`);
  }

  if (choice[0] !== '1' && choice[0] !== '2') return end('Choix invalide.');
  const crew = crewByPhone(ctx.db, ctx.piiKey, input.phoneNumber);
  if (!crew) return UNKNOWN;
  const st = crewStatus(ctx.db, crew, now, 3);

  if (choice[0] === '1') {
    const c = st.cover;
    const head = `${st.pseudonym}`;
    switch (c.state) {
      case 'covered':
        return end(
          `${head}: couvert jusqu'au ${dayMonth(c.activeUntil!)}. ${fcfaText(c.payoutFcfa!)} FCFA si la mer est dangereuse. Code ${st.code}`,
        );
      case 'waiting':
        return end(`${head}: couverture active le ${dayMonth(c.activeFrom!)}. Code ${st.code}`);
      case 'awaiting_premium':
        return end(`${head}: prime pas encore payee. Voyez le CLPA. Code ${st.code}`);
      default:
        return end(`${head}: pas de couverture active. Voyez le CLPA. Code ${st.code}`);
    }
  }

  const paid = st.payouts.filter((p) => p.status === 'paid');
  if (paid.length === 0) return end(`${st.pseudonym}: aucun paiement pour le moment.`);
  const lines = paid.map(
    (p) =>
      `${dayMonth(p.date)}: ${fcfaText(p.amountFcfa)} FCFA${p.simulated ? ' (simule)' : ctx.testFunds ? ' (test)' : ''}`,
  );
  return end(`${st.pseudonym}, derniers paiements:\n${lines.join('\n')}`);
}
