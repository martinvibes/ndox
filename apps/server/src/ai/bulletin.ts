/**
 * Daily sea bulletin (docs/BRIEF.md §11): a short French note from the day's attestations, written
 * by the model when one is configured, else by a template. Every number the model writes must be
 * one of the facts it was given, or the template is used instead. Posted as a Nostr kind 1 note
 * signed by the pool key, stored once per day (re-runs only retry publishing).
 */
import { finalizeEvent, type NostrEvent } from '@ndox/oracle';
import { SITES } from '@ndox/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { cmToM } from '../db/index.js';
import { attestations, bulletins, payouts, sites } from '../db/schema.js';
import { errorMessage, type Log } from '../lib/log.js';
import { atUtc, isoDate, isoSeconds, unixSeconds, type Clock } from '../lib/time.js';
import { dueForRetry, type PublishResult, type Publisher } from '../nostr/publisher.js';
import type { TextModel } from './model.js';

export const BULLETIN_AT = '05:30';
/** Post with whatever is attested by then, even if a site is still missing. */
export const BULLETIN_LATEST = '06:30';
const MAX_CHARS = 700;

export interface SiteFacts {
  site: string;
  name: string;
  thresholdM: number;
  outcome: 'calme' | 'danger' | 'indisponible' | null;
  waveM: number | null;
  paidCrews: number;
  paidFcfa: number;
}

export interface BulletinFacts {
  date: string;
  testFunds: boolean;
  sites: SiteFacts[];
}

export interface BulletinCtx {
  db: Db;
  clock: Clock;
  log: Log;
  model: TextModel | null;
  publisher: Publisher | null;
  poolSecret: string;
  publicBaseUrl: string;
  testFunds: boolean;
}

export type BulletinRow = typeof bulletins.$inferSelect;

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const frDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const m = (x: number) => x.toFixed(1).replace('.', ',');
const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}\u00a0FCFA`;

export function bulletinFacts(db: Db, date: string, testFunds: boolean): BulletinFacts {
  const enabled = db.select().from(sites).where(eq(sites.enabled, true)).all();
  return {
    date,
    testFunds,
    sites: SITES.flatMap((s) => {
      const row = enabled.find((r) => r.id === s.id);
      if (!row) return [];
      const att = db
        .select()
        .from(attestations)
        .where(
          and(
            eq(attestations.site, s.id),
            eq(attestations.date, date),
            isNull(attestations.replayRunId),
          ),
        )
        .get();
      const paid = att
        ? db
            .select()
            .from(payouts)
            .where(and(eq(payouts.attestationId, att.eventId), eq(payouts.status, 'paid')))
            .all()
        : [];
      return [
        {
          site: s.id,
          name: s.name.replace(/\s*\(.*\)\s*$/, ''),
          thresholdM: cmToM(row.thresholdCm),
          outcome: att?.outcome ?? null,
          waveM: att?.decisiveM ?? null,
          paidCrews: paid.length,
          paidFcfa: paid.reduce((a, p) => a + p.amountFcfa, 0),
        },
      ];
    }),
  };
}

export function templateBulletin(f: BulletinFacts): string {
  const lines = f.sites.map((s) => {
    if (s.outcome === 'danger') {
      const paid = s.paidCrews
        ? ` ${s.paidCrews} équipage${s.paidCrews > 1 ? 's' : ''} payé${s.paidCrews > 1 ? 's' : ''}, ${fcfa(s.paidFcfa)}${f.testFunds ? ' (fonds de test)' : ''}.`
        : '';
      return `${s.name} : mer dangereuse, houle ${m(s.waveM!)} m (seuil ${m(s.thresholdM)} m).${paid}`;
    }
    if (s.outcome === 'calme')
      return `${s.name} : mer calme, houle ${m(s.waveM!)} m (seuil ${m(s.thresholdM)} m).`;
    if (s.outcome === 'indisponible') return `${s.name} : données indisponibles.`;
    return `${s.name} : pas encore de résultat.`;
  });
  const danger = f.sites.some((s) => s.outcome === 'danger');
  return [
    `Mer du ${frDate(f.date)}.`,
    ...lines,
    danger ? 'Là où la mer est dangereuse, restez à terre.' : 'Bonne pêche, prudence au large.',
  ].join('\n');
}

const SYSTEM = `Tu écris le bulletin quotidien de la mer de Ndox pour les pêcheurs artisanaux du Sénégal et leurs soutiens.
Règles :
- Français simple, 3 à 6 phrases courtes, au plus 500 caractères.
- Utilise uniquement les faits du JSON fourni. N'invente aucun chiffre, lieu, prévision, cause ni conseil.
- Pour chaque site : mer dangereuse ou calme, avec la houle en mètres (virgule décimale, ex. 2,7 m). outcome "indisponible" : données indisponibles ; outcome null : pas encore de résultat.
- Si des équipages ont été payés, dis combien et le total en FCFA. Si testFunds est vrai, précise que ce sont des paiements de test.
- Les jours de danger, conseille de rester à terre.
- Pas de titre, pas de liste, pas de markdown, pas d'émoji.`;

/** Numbers the bulletin may contain: every fact, as written in French. */
function allowedNumbers(f: BulletinFacts): Set<string> {
  const ok = new Set<string>([
    String(Number(f.date.slice(8, 10))),
    f.date.slice(0, 4),
    f.date.slice(8, 10),
  ]);
  for (const s of f.sites) {
    ok.add(s.thresholdM.toFixed(1)).add(String(s.thresholdM));
    if (s.waveM !== null) ok.add(s.waveM.toFixed(1)).add(String(s.waveM));
    ok.add(String(s.paidCrews)).add(String(s.paidFcfa));
  }
  return ok;
}

/** True when every number in `text` is one of the facts. */
export function numbersAreFacts(text: string, f: BulletinFacts): boolean {
  const ok = allowedNumbers(f);
  const found = text.match(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?/g) ?? [];
  return found.every((n) => {
    const v = n.replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
    return ok.has(v) || ok.has(String(Number(v)));
  });
}

export async function writeBulletin(
  model: TextModel | null,
  f: BulletinFacts,
  log: Log,
): Promise<{ text: string; source: 'ai' | 'template'; model: string | null }> {
  if (model) {
    try {
      const text = (
        await model.complete({ system: SYSTEM, user: JSON.stringify(f), maxTokens: 600 })
      )
        .replace(/[*#_`]/g, '')
        .trim();
      if (text.length <= MAX_CHARS && numbersAreFacts(text, f))
        return { text: `Mer du ${frDate(f.date)}. ${text}`, source: 'ai', model: model.model };
      log.warn('bulletin: model text rejected, using the template', { chars: text.length });
    } catch (err) {
      log.warn('bulletin: model failed, using the template', { error: errorMessage(err) });
    }
  }
  return { text: templateBulletin(f), source: 'template', model: null };
}

function noteEvent(ctx: BulletinCtx, row: BulletinRow): NostrEvent {
  const by = row.source === 'ai' ? `Rédigé par IA (${row.model}) à partir des attestations.` : '';
  return finalizeEvent(
    {
      kind: 1,
      created_at: unixSeconds(ctx.clock()),
      tags: [['t', 'ndox']],
      content: [row.text, by, `Preuves : ${ctx.publicBaseUrl}/verifier`]
        .filter(Boolean)
        .join('\n\n'),
    },
    ctx.poolSecret,
  );
}

async function publish(ctx: BulletinCtx, row: BulletinRow): Promise<BulletinRow> {
  if (!ctx.publisher) return row;
  const now = ctx.clock();
  const ev = row.eventJson ? (JSON.parse(row.eventJson) as NostrEvent) : noteEvent(ctx, row);
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
  return ctx.db
    .update(bulletins)
    .set({
      eventJson: JSON.stringify(ev),
      nostrId: ev.id,
      publishResult: { ...res, at: isoSeconds(now) },
      publishedAt: res.ok ? isoSeconds(now) : null,
    })
    .where(eq(bulletins.date, row.date))
    .returning()
    .get();
}

/**
 * Scheduler step: from 05:30 UTC, once every enabled site is attested (or from 06:30 with what
 * there is), writes today's bulletin and posts it; later ticks only retry the post.
 */
export async function maybeBulletin(ctx: BulletinCtx): Promise<BulletinRow | null> {
  const now = ctx.clock();
  const date = isoDate(now);
  if (now < atUtc(date, BULLETIN_AT) || now >= atUtc(date, '18:00')) return null;
  const existing = ctx.db.select().from(bulletins).where(eq(bulletins.date, date)).get();
  if (existing) {
    if (existing.publishedAt || !ctx.publisher || !dueForRetry(existing.publishResult, now))
      return null;
    return publish(ctx, existing);
  }
  const facts = bulletinFacts(ctx.db, date, ctx.testFunds);
  const attested = facts.sites.filter((s) => s.outcome !== null).length;
  if (attested === 0) return null;
  if (attested < facts.sites.length && now < atUtc(date, BULLETIN_LATEST)) return null;
  const w = await writeBulletin(ctx.model, facts, ctx.log);
  const row = ctx.db
    .insert(bulletins)
    .values({ date, text: w.text, source: w.source, model: w.model })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) return null;
  ctx.log.info('bulletin written', { date, source: w.source });
  return publish(ctx, row);
}

export function latestBulletin(db: Db): BulletinRow | undefined {
  return db.select().from(bulletins).orderBy(desc(bulletins.date)).limit(1).get();
}
