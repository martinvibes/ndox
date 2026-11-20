/**
 * `/e/:code` (docs/BRIEF.md §10.4): the crew status page, rendered on the server as one small HTML
 * document (no script, inline CSS, a few KB) so it opens on 2G and on any phone browser.
 * French first: the crews and the CLPA read French.
 */
import type { CrewStatus } from './status.js';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}\u00a0FCFA`;

const MONTHS = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];
/** "12 déc." from an ISO date or timestamp (UTC: Senegal has no DST). */
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const dayTime = (iso: string) => `${day(iso)}, ${iso.slice(11, 16)} GMT`;

const CSS = `:root{--bg:#f6f8fa;--s:#fff;--i:#0b1f33;--m:#5b6b7c;--l:#e3e8ee;--o:#0b5c8e;--c:#1f7a55;--cb:#e7f4ee;--d:#b42318;--db:#fdecea;--w:#b54708;--wb:#fef3e2}
@media(prefers-color-scheme:dark){:root{--bg:#0b1520;--s:#11202e;--i:#e8eef4;--m:#9aabbc;--l:#22364a;--o:#5fb0e6;--c:#5cc79a;--cb:#10301f;--d:#f2877d;--db:#3a1512;--w:#f0a35e;--wb:#3a2610}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--i);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:1.25rem 1rem 2rem}a{color:var(--o)}
h1{font-size:1.5rem;line-height:1.2;margin:.25rem 0 0}.m{color:var(--m);font-size:.875rem;margin:0}
.st{margin:1.25rem 0;padding:1rem 1.1rem;border-radius:.75rem;border:1px solid var(--l);background:var(--s)}
.st b{display:block;font-size:1.25rem;line-height:1.3}.st p{margin:.35rem 0 0}
.ok{background:var(--cb);border-color:transparent}.ok b{color:var(--c)}
.wt{background:var(--wb);border-color:transparent}.wt b{color:var(--w)}
.no b{color:var(--m)}
h2{font-size:1rem;margin:1.5rem 0 .5rem}ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--l)}
li{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--l)}
li span:last-child{text-align:right}.tag{display:inline-block;font-size:.75rem;padding:0 .4rem;border-radius:.3rem;background:var(--wb);color:var(--w);margin-left:.35rem;vertical-align:middle}
footer{margin-top:2rem;font-size:.8125rem;color:var(--m)}form{display:flex;gap:.5rem;margin-top:1rem}
input{flex:1;font:inherit;padding:.6rem .75rem;border:1px solid var(--l);border-radius:.5rem;background:var(--s);color:var(--i);text-transform:uppercase;letter-spacing:.1em}
button{font:inherit;padding:.6rem 1rem;border:0;border-radius:.5rem;background:var(--o);color:#fff}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}<footer>Ndox · assurance mer agitée des pêcheurs, payée en Lightning. <a href="/">ndox</a> · <a href="/verifier">vérifier les preuves</a></footer></main></body></html>`;
}

export function codeFormPage(message?: string): string {
  return shell(
    'Ndox · Mon équipage',
    `<h1>Mon équipage</h1><p class="m">Entrez le code à 6 caractères reçu par SMS ou donné par le CLPA.</p>${
      message ? `<div class="st no"><b>${esc(message)}</b></div>` : ''
    }<form action="/e" method="get"><input name="code" maxlength="6" autocomplete="off" aria-label="Code" placeholder="K7Q2MD" required><button>Voir</button></form>`,
  );
}

export function crewPage(st: CrewStatus, opts: { now: Date; testFunds: boolean }): string {
  const c = st.cover;
  const money = (simulated: boolean) =>
    simulated
      ? '<span class="tag">Simulé</span>'
      : opts.testFunds
        ? '<span class="tag">Test</span>'
        : '';
  let cover: string;
  switch (c.state) {
    case 'covered':
      cover = `<div class="st ok"><b>Couvert jusqu’au ${day(c.activeUntil!)}</b><p>Si la mer est dangereuse un jour de couverture, l’équipage reçoit ${fcfa(c.payoutFcfa!)} le matin même, sans rien demander.</p></div>`;
      break;
    case 'waiting':
      cover = `<div class="st wt"><b>Couverture active le ${dayTime(c.activeFrom!)}</b><p>Prime reçue. Le délai d’attente évite qu’on s’assure la veille d’une tempête annoncée.</p></div>`;
      break;
    case 'awaiting_premium':
      cover = `<div class="st no"><b>Prime pas encore payée</b><p>La couverture commence après le paiement de la prime. Voyez le CLPA de votre quai.</p></div>`;
      break;
    default:
      cover = `<div class="st no"><b>Pas de couverture en cours</b><p>Voyez le CLPA de votre quai pour la renouveler.</p></div>`;
  }
  const paid = st.payouts.filter((p) => p.status === 'paid');
  const pending = st.payouts.filter((p) => p.status !== 'paid');
  const rows = [
    ...paid.map(
      (p) =>
        `<li><span>${day(p.date)}${p.decisiveM !== null ? ` · houle ${p.decisiveM.toFixed(1).replace('.', ',')}\u00a0m` : ''}<br><a href="/verifier/${encodeURIComponent(p.eventId)}">preuve</a></span><span>${fcfa(p.amountFcfa)}${money(p.simulated)}<br><span class="m">${p.amountSat.toLocaleString('fr-FR')}\u00a0sats</span></span></li>`,
    ),
    ...pending.map(
      (p) =>
        `<li><span>${day(p.date)}</span><span>${fcfa(p.amountFcfa)}${money(p.simulated)}<br><span class="m">${p.status === 'failed' ? 'échec, le CLPA est prévenu' : 'paiement en cours'}</span></span></li>`,
    ),
  ];
  return shell(
    `Ndox · ${st.pseudonym}`,
    `<p class="m">${esc(st.siteName)}${st.demo ? ' · <span class="tag">Démo</span>' : ''}</p><h1>${esc(st.pseudonym)}</h1>${cover}<h2>Derniers paiements</h2>${
      rows.length ? `<ul>${rows.join('')}</ul>` : '<p class="m">Aucun paiement pour le moment.</p>'
    }<p class="m" style="margin-top:1rem">Mis à jour ${dayTime(opts.now.toISOString())} · code ${esc(st.code)}</p>`,
  );
}
