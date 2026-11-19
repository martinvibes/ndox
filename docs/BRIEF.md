# Ndox — Build Brief for Claude Code

> **How to use this file:** create an empty repo, save this file as `docs/BRIEF.md`, then tell Claude Code:
> *"Read docs/BRIEF.md end to end, then start Phase 0. Stop at each checkpoint, show me what's real vs simulated, and commit."*

---

## 0. Ground rules (read before writing any code)

1. **Never fake data silently.** Anything simulated (fake wallet, SMS sandbox, mobile-money cash-out, demo crews) must show a visible **"Simulé"** badge in the UI and be listed in the README's *Réel vs simulé* table.
2. **Do not invent Wolof.** Put every Wolof string in `apps/web/src/locales/wo.json` with the value `"TODO_NATIVE_REVIEW"` and fall back to French. A native speaker will fill them in.
3. **Verify external APIs against their current docs before coding them.** Do not guess identifiers. This applies especially to: Open-Meteo marine model IDs, `@getalby/sdk` (NWC client API), `@getalby/lightning-tools`, `@noble/curves` (Schnorr utils location differs between major versions), `nostr-tools` v2, the draft NIP-88 (https://github.com/nostr-protocol/nips/pull/919), dlcspecs `Oracle.md`, and the Africa's Talking SDK.
4. **Money is integers.** Sats and millisats as `bigint` or integer numbers, never floats. FCFA amounts are integers too.
5. **Every payout path is idempotent.** A crash or retry must never pay twice.
6. **No secrets in git.** Only `.env.example`. Never log secrets, phone numbers, Lightning addresses or names.
7. **Work in phases (§13).** After each phase: `pnpm typecheck && pnpm lint && pnpm test` green, commit with a conventional-commit message, and print a short "real vs simulated" summary.
8. **Small, clean, fast.** Respect the performance budget in §10. No heavy UI kits or chart libraries.
9. **Decisions log.** When this brief leaves something open, choose the simplest option consistent with it and record it in `docs/DECISIONS.md` (one line each: date, decision, why).
10. **Tests are part of the feature.** No phase is done without tests for its logic.

---

## 1. What we are building

**Ndox** (Wolof for *water*) is **preventive solidarity for Senegal's artisanal fishers**. On days the sea is forecast to be too dangerous, Ndox automatically pays every covered crew member at dawn, so nobody has to risk their life for that day's income.

- A **Bitcoin-style oracle** publishes on Nostr, the evening before, which sea fact it will sign tomorrow (committing to a nonce). At dawn it signs the outcome (`calme`, `danger` or `indisponible`) based on **two independent wave models**. If it ever signs two different outcomes for the same event, its private key can be computed by anyone, so lying is self-destructive.
- A **community pool** (funded by the fishing council's existing levy, crew premiums and diaspora top-ups) pays over **Lightning** to every active policy at that landing site.
- Everything is **publicly verifiable**: announcements, attestations, anonymised policies and payment proofs are on Nostr, and a public page re-checks the maths in the browser.

**Framing (important for UI copy and README):** this is *solidarité préventive*, the fishing council's (CLPA's) own mutual pot made automatic and paid **before** the danger. It is **not** an insurance company. A licensed insurer is the path to scale, on the roadmap.

**Tagline:** *Quand la mer dit non, Ndox paie.*

### Context
- Built for **Dakar Bitcoin Hack 2026 by Btrust** (Devpost). Theme: tools that improve life in Africa using Bitcoin, Lightning, Nostr and AI.
- Judging criteria: **usefulness & local impact**, **security by design**, **UX on low-bandwidth mid-range phones**, **working MVP (one-command setup, seed data, testable happy path)**, **clear pitch & docs**.
- Entries must include at least a Bitcoin/Lightning wallet implementation.
- Key facts used in the pitch (sources in README): the sea killed 181 Senegalese fishers in 2017; the Saint-Louis region recorded 359 accidents and 218 deaths between 2018 and March 2026; ANACIM (met agency) regularly issues dangerous-swell alerts (e.g. 2.5 m at Saint-Louis and Kayar on 5 Feb 2026) and fishers often go out anyway for income; the Kayar CLPA already deducts 200 FCFA per pirogue fuel purchase into a fund for sea accidents and search pirogues; Kayar counted 1,302 pirogues (2020) and 8,000+ fishers in season (Dec–Jun); the Caribbean's COAST (World Bank/CCRIF, 2019) is the world's first parametric fisheries cover but is bought by governments.

---

## 2. Users

| User | What they do | Interface |
| --- | --- | --- |
| **Crew member** (matelot) | Covered by a policy; gets paid on danger days; checks status | **No app.** SMS at dawn; USSD menu; optional tiny status page via a 6-character code |
| **CLPA treasurer** | Enrols crews, records levy deposits, watches pool health, runs replays | Dashboard (`/conseil`) |
| **Diaspora sponsor** | Tops up the pool or one crew's cover from any Lightning wallet or by zap | Public page (`/soutenir`) |
| **Verifier** (anyone, incl. judges) | Re-checks attestations, data and payments | Public page (`/verifier`) |

**Honesty rule:** in the hackathon deployment, all crews are **demo crews with team-controlled Lightning addresses**. The UI labels them *Équipages de démonstration*. No real fisher is enrolled.

---

## 3. The daily loop (per landing site)

Senegal is on **UTC+0 all year (no DST)**, so all schedules are in UTC.

| Time (UTC) | Job | What happens |
| --- | --- | --- |
| 20:00 (day D-1) | `announce` | For each site, generate a fresh nonce `k`, store it encrypted, publish **kind 88** announcement for day D (window 06:00–18:00) with nonce point `R`. |
| 05:00 (day D) | `fetch` | Fetch the latest forecast from **both wave models** for the window. Store the raw responses and their SHA-256. |
| 05:15 | `attest` | Apply the trigger rule (§5.3). Sign the outcome with the committed nonce. Publish **kind 89** attestation. Delete `k`. |
| 05:20 | `payout` | Verify the attestation against the announcement (same code the public verifier uses). If `danger`, pay every eligible policy for that site. Publish a receipt per payment. |
| 05:30 | `notify` | SMS to each covered crew member; post a short French bulletin to Nostr (kind 1); ping the health-check URL. |

Every job must be **re-runnable** (idempotent) and safe after a crash: e.g. if the server restarts at 05:16, re-running `attest` must not sign twice with a different outcome; it must detect the existing attestation and stop.

---

## 4. Architecture and repo layout

```
ndox/
  packages/
    oracle/        @ndox/oracle  — announce, attest, verify, equivocation-recovery, event (de)serialisation. Zero server deps. MIT. Publishable to npm.
    shared/        @ndox/shared  — zod schemas, types, money + FCFA helpers, site config, trigger rule, i18n keys
  apps/
    server/        Fastify API + scheduler (node-cron) + wave fetcher + payout engine + wallet/notifier adapters + SQLite (Drizzle)
    web/           Vite + React + TypeScript + Tailwind + vite-plugin-pwa (public site + CLPA dashboard), built and served by the server
  data/
    seed/          cached forecasts, ERA5 history, backtest results, demo crews (so Docker runs offline)
  scripts/         data:fetch, backtest, seed, replay
  docs/            BRIEF.md, DECISIONS.md, ARCHITECTURE.md, THREAT_MODEL.md, REAL_VS_SIMULATED.md
  Dockerfile, docker-compose.yml, .env.example, .github/workflows/ci.yml
```

**Stack:** Node 20+, TypeScript (strict), pnpm workspaces, Fastify, zod, Drizzle ORM + better-sqlite3, node-cron, nostr-tools v2, @noble/curves + @noble/hashes, @getalby/sdk, @getalby/lightning-tools, Vite, React, Tailwind CSS, lucide-react (tree-shaken icons), vite-plugin-pwa, vitest, Playwright (smoke E2E), ESLint + Prettier.

**Two separate keys (least privilege):**
- `ORACLE_SECRET`: signs announcements and attestations. Its x-only public key **is** the oracle's Nostr pubkey. It never touches money.
- `POOL_SECRET`: signs policy events and payout receipts on Nostr. Separate from the oracle.
- The **payer** is a Nostr Wallet Connect (NWC) connection with a **daily budget** set in the wallet *and* enforced by the app.

---

## 5. Data sources and the trigger rule

### 5.1 Landing sites (config in `packages/shared/src/sites.ts`)

Coordinates are **approximate offshore points** so the marine grid cell is ocean. On first fetch, if the API returns nulls, nudge the point ~0.05° further offshore and record the final coordinates in `DECISIONS.md`.

| id | Name | Approx. lat, lon (offshore) | Season (default) |
| --- | --- | --- | --- |
| `kayar` | Kayar | 14.95, -17.20 | Dec–Jun |
| `saint-louis` | Saint-Louis (Guet Ndar) | 16.02, -16.60 | all year |
| `joal` | Joal-Fadiouth | 14.15, -16.95 | all year |
| `soumbedioune` | Soumbédioune (Dakar) | 14.68, -17.50 | all year |

### 5.2 Wave data (Open-Meteo Marine API, free, no key, non-commercial)
- Docs: https://open-meteo.com/en/docs/marine-weather-api
- Endpoint: `https://marine-api.open-meteo.com/v1/marine`
- Live trigger: hourly `wave_height` (also store `swell_wave_height`) for the window, from **two different wave models** selected via the `models` parameter (target: ECMWF WAM and NCEP GFS-Wave; **look up the exact model IDs in the docs**). `timezone=GMT`.
- History for backtest: the ERA5-Ocean reanalysis model via the same API with `start_date`/`end_date` (verify the model ID). Fetch in yearly chunks, cache to `data/seed/`.
- Store every raw response, its URL, fetch time and SHA-256. The attestation includes the hashes so anyone can check what the oracle saw. Open-Meteo also keeps archived forecasts, which the verify page can use to re-check recent days.

### 5.3 Trigger rule (pure function in `@ndox/shared`, fully tested)
```
for each model m: max_m = max(hourly wave_height in [06:00, 18:00) UTC)
if any model missing or has < 10 valid hours  → "indisponible"
else if min(max_m over both models) >= threshold_m → "danger"
else → "calme"
```
- Default `threshold_m = 2.5` (the height used in recent ANACIM dangerous-swell alerts). Configurable per site.
- Make the variable configurable (`wave_height` or `swell_wave_height`) and show both in the backtest.

### 5.4 Price (sats ↔ FCFA)
- BTC/EUR from `https://mempool.space/api/v1/prices`. FCFA (XOF) is pegged: **1 EUR = 655.957 XOF**.
- Policies are denominated in **FCFA**; the sat amount is computed at payout time and stored with the rate used.
- Cache the price for 10 minutes; if unavailable, use the last known price and flag it in the UI.

---

## 6. The oracle (`packages/oracle`) — the technical centrepiece

### 6.1 Cryptography (BIP340-style Schnorr with a pre-committed nonce)
- Oracle keypair: secret `x`, x-only public key `P` (normalise `x` so `P` has even Y, per BIP340).
- **Announce:** draw a fresh random scalar `k`; compute `R = k·G`; if `R.y` is odd, set `k = n − k`. Publish `R.x` (32 bytes hex). Store `k` encrypted until attestation. **Never reuse a nonce.**
- **Outcome message:** `m = taggedHash("DLC/oracle/attestation/v0", utf8(outcome))`. Check the tag against dlcspecs `Oracle.md`; if it differs, use the spec's tag and note it in `DECISIONS.md`.
- **Attest:** `e = int(taggedHash("BIP0340/challenge", R.x ‖ P.x ‖ m)) mod n`; `s = (k + e·x) mod n`. The attestation signature is `sig = R.x ‖ s` (64 bytes).
- **Verify:** the signature must pass a standard BIP340 `schnorr.verify(sig, m, P.x)`, **and** `R.x` must equal the nonce point from the announcement.
- **Equivocation recovery** (public function): given two valid attestations with the same `R` for different outcomes, `x = (s1 − s2) · (e1 − e2)⁻¹ mod n`. Return the recovered key.

`@noble/curves` signing APIs derive their own nonce, so implement `attest` by hand with its field/point utilities (find where `taggedHash`, `lift_x`, `mod`, etc. live in the installed version).

### 6.2 Required tests (vitest)
- A manual `attest` signature passes `schnorr.verify` from `@noble/curves` (cross-check).
- Wrong outcome, wrong pubkey, wrong nonce point → verification fails.
- Equivocation: sign `calme` and `danger` with the same `k` → `recoverKey` returns the oracle secret.
- Odd-Y handling for both `P` and `R` (loop over many random keys).
- Serialisation round-trip of announcement and attestation events.
- If dlcspecs publishes test vectors you can apply, include them.

### 6.3 Nostr events
Use the **draft NIP-88 kinds**: `88` = oracle announcement, `89` = oracle attestation. Read the draft first.

- **Phase A (required):** content is JSON (below), signed as a normal Nostr event by the oracle key. README must say: *"Uses NIP-88 kinds and DLC-style signatures; content is JSON. DLC TLV encoding is on the roadmap."* Do not claim full NIP-88 compliance.
- **Phase B (stretch):** also include the dlcspecs TLV encoding (e.g. via `@node-dlc/messaging` if it works cleanly), so DLC tools like Kormir/ddk can read the events.

Kind 88 content:
```json
{
  "v": 1,
  "eventId": "ndox:kayar:2026-11-20",
  "site": "kayar",
  "window": { "start": "2026-11-20T06:00:00Z", "end": "2026-11-20T18:00:00Z" },
  "outcomes": ["calme", "danger", "indisponible"],
  "rule": { "variable": "wave_height", "thresholdM": 2.5, "models": ["<modelA>", "<modelB>"], "logic": "danger if both models' window max >= threshold" },
  "oraclePubkey": "<P.x hex>",
  "noncePoint": "<R.x hex>",
  "attestAt": "2026-11-20T05:15:00Z"
}
```
Tags: `["t","ndox"]`, `["site","kayar"]`, `["ndox-event","ndox:kayar:2026-11-20"]`.

Kind 89 content:
```json
{
  "v": 1,
  "eventId": "ndox:kayar:2026-11-20",
  "outcome": "danger",
  "noncePoint": "<R.x hex>",
  "s": "<32-byte hex>",
  "data": {
    "fetchedAt": "2026-11-20T05:00:12Z",
    "models": [
      { "id": "<modelA>", "windowMaxM": 2.81, "validHours": 12, "url": "<request url>", "sha256": "<raw response hash>" },
      { "id": "<modelB>", "windowMaxM": 2.74, "validHours": 12, "url": "<request url>", "sha256": "<raw response hash>" }
    ]
  }
}
```
Tags: `["e","<kind 88 nostr id>"]`, `["t","ndox"]`, `["site","kayar"]`, `["ndox-event", "..."]`.

Relays (configurable): `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`. Publish to all; succeed if at least 2 accept. Support a `--dry-run` flag that signs but does not publish.

**Replay events** (demo of past days) use a **separate demo oracle key** and the tag `["t","ndox-replay"]`, and the UI labels them *Rejeu*. They must never be confused with live attestations.

---

## 7. Policies, pool and payouts

### 7.1 Policy rules (defaults in settings, editable in dashboard)
- Weekly cover, auto-renewing while the premium is paid. Per-crew payout per danger day: **2,000 FCFA** (default).
- **Waiting period: 72 h** from premium payment before a policy can pay (blocks buying cover after seeing a storm in the forecast).
- Premium computed from the backtest (§12); shown in FCFA and sats.
- A policy can be funded by: the crew member, the CLPA (levy), or a sponsor (diaspora).

### 7.2 Policy event on Nostr (signed by `POOL_SECRET`)
Kind `30078` (NIP-78 app data), `d` tag = `ndox:policy:<policyId>`. **No personal data.**
```json
{ "v": 1, "policyId": "...", "site": "kayar", "payoutFcfa": 2000, "thresholdM": 2.5,
  "activeFrom": "...", "activeUntil": "...", "holderCommitment": "sha256(salt || crewId)",
  "fundedBy": "crew|clpa|sponsor", "demo": true }
```

### 7.3 Payout engine (pure core + thin I/O shell)
```
on attestation A for site S:
  verify(A) with @ndox/oracle (same code as the public verifier) — abort + alert if invalid
  if A.outcome != "danger": record "no payout", publish bulletin, stop
  policies = active policies for S where activeFrom <= A.window.start < activeUntil
  due = Σ payoutFcfa → convert to sats at current rate
  available = min(wallet balance − reserve floor, DAILY_PAYOUT_CAP_SATS − paid today)
  factor = available >= due ? 1 : available / due      (pro-rata; record shortfall publicly)
  for each policy p:
    insert payout(p.id, A.id) — UNIQUE(policy_id, attestation_id) makes this idempotent
    amount = floor(p.amount_sat * factor)
    get invoice from the crew's Lightning address (store it); pay via wallet; store preimage
    on failure: lookup the stored invoice first; only fetch a new invoice if the old one is confirmed unpaid
    publish receipt (kind 30078, d = ndox:payout:<policyId>:<attestationId>) with amount, payment_hash, preimage
```
Payout state machine: `pending → paying → paid | failed` (max 5 attempts, exponential backoff, then alert the dashboard).

### 7.4 Money in
- **Crew premium:** dashboard creates a Lightning invoice; when paid, the policy activates after the waiting period.
- **CLPA levy deposit:** treasurer records a deposit (the 200 FCFA fuel levy converted to sats) via an invoice; labelled *Versement caisse CLPA*.
- **Sponsor top-up:** public page creates an invoice for the pool or for one crew (by public pseudonym). Also accept **zaps** (NIP-57) to the pool's Nostr profile; count `kind 9735` zap receipts as top-ups.
- Show a live **coverage ratio** = pool available ÷ (active policies × payout × worst-case danger days in 7 days).

---

## 8. Adapters (all behind interfaces, all swappable)

```ts
interface Wallet {
  makeInvoice(amountSat: number, memo: string): Promise<{ invoice: string; paymentHash: string }>;
  payInvoice(invoice: string): Promise<{ preimage: string }>;
  lookupInvoice(paymentHash: string): Promise<{ paid: boolean; preimage?: string }>;
  getBalanceSat(): Promise<number>;
}
```
- `NwcWallet` using `@getalby/sdk` (NIP-47; amounts in millisats). Works with Alby Hub, Coinos or any NWC wallet.
- `FakeWallet` (deterministic, in-memory, generates real-looking BOLT11-shaped invoices and preimages whose SHA-256 matches the payment hash). Labelled **Simulé**. Used by Docker by default and in tests.
- `payToLightningAddress(addr, sat)` via `@getalby/lightning-tools` (LNURL-pay → invoice → `payInvoice`).
- `MobileMoneyCashout` interface with a **simulated** Banxaas-style adapter (Lightning → Wave/Orange Money). Clearly labelled; no real API calls.
- `Notifier`: `ConsoleNotifier` (default) and `AfricasTalkingSms` (sandbox).
- `UssdHandler`: Africa's Talking sandbox callback (`POST /api/ussd`): menu `1. Statut de ma couverture  2. Derniers paiements  3. Mer aujourd'hui`. Works with the AT simulator.

SMS template (French, ≤ 160 chars, no PII beyond what the recipient already knows):
> `NDOX Kayar: mer dangereuse aujourd'hui (houle 2,8 m). 2 000 FCFA envoyes. Restez a terre. Code: K7Q2MD`

---

## 9. API (Fastify, zod-validated, JSON)

Public:
- `GET /api/sites` · `GET /api/today` (status card per site) · `GET /api/forecast/:site` (7-day danger outlook, not attested)
- `GET /api/attestations?site=&limit=` · `GET /api/attestations/:eventId` (announcement + attestation + raw data hashes + payouts)
- `GET /api/pool` (balance, coverage ratio, active policies, payouts this season, last price)
- `GET /api/payouts?limit=` · `GET /api/backtest`
- `POST /api/sponsor/invoice` `{ amountFcfa, site?, crewPseudonym? }` · `GET /api/sponsor/invoice/:paymentHash`
- `GET /api/status/:code` (crew status page; rate-limited; no PII)
- `GET /healthz`

Admin (session cookie, `ADMIN_PASSWORD_HASH`; stretch: NIP-98 Nostr login for an allow-listed CLPA pubkey):
- `POST /api/admin/login` · `GET|POST /api/admin/crews` · `POST /api/admin/policies` · `POST /api/admin/deposits`
- `POST /api/admin/replay` `{ site, date }` · `GET|PUT /api/admin/settings`

Integration: `POST /api/ussd` · `POST /api/sms/delivery`

---

## 10. UI — clean, calm, French-first

### 10.1 Principles
- **One idea per screen. Big, honest status.** The home page answers *"Is the sea dangerous today, and did Ndox pay?"* in one glance.
- **Mobile-first at 360 px**, then scale up. Public pages max-width 720 px; dashboard max-width 1200 px.
- **French by default**, English toggle, Wolof only for reviewed strings. Plain words, no crypto jargon on public pages ("paiement", not "invoice"; "preuve", not "preimage", with the technical term in a tooltip on the verify page).
- **Calm, maritime, trustworthy.** Lots of white space, no gradients, no glassmorphism, no stock photos.

### 10.2 Design tokens (Tailwind theme)
| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#F6F8FA` | page background |
| `surface` | `#FFFFFF` | cards |
| `ink` | `#0B1F33` | primary text |
| `muted` | `#5B6B7C` | secondary text |
| `line` | `#E3E8EE` | borders, dividers |
| `ocean` | `#0B5C8E` (50: `#E8F2F9`) | primary actions, links |
| `calm` | `#1F7A55` (bg `#E7F4EE`) | *Calme* status |
| `danger` | `#B42318` (bg `#FDECEA`) | *Danger* status |
| `warn` | `#B54708` (bg `#FEF3E2`) | *Indisponible*, simulated badges |

- Type: **Inter** (self-hosted, latin subset, variable) with `system-ui` fallback. Sizes 14 / 16 / 20 / 28 / 40. Use **tabular numbers** for all amounts.
- Radius: cards 12 px, buttons 8 px. Shadows: none or `0 1px 2px rgba(11,31,51,.06)`. Spacing on a 4/8 px scale. Tap targets ≥ 44 px.
- FCFA formatting: `Intl.NumberFormat('fr-SN')` → `2 000 FCFA`. Times shown in GMT with "heure de Dakar".
- Icons: lucide-react, 20 px, stroke 1.75. Charts: **hand-rolled SVG components** (bar chart, sparkline, timeline). No chart library.
- Dark mode: tokens ready; ship light mode first.

### 10.3 Components
`StatusCard` (site, big CALME/DANGER/INDISPONIBLE label, both model values vs threshold, "Attesté à 05:15 GMT · Vérifier →"), `StatTile`, `Badge` (incl. **Simulé**, **Rejeu**, **Démo**), `CheckList` (verification steps with ticks), `InvoiceQR` (QR + copy + live "payé" state), `Timeline` (replay steps), `DataTable`, `EmptyState`, `Toast`.

### 10.4 Pages
Public:
1. **`/` Accueil:** tagline; four `StatusCard`s (today, per site); pool tiles (balance in FCFA, crews covered, paid this season, coverage ratio); "Comment ça marche" in three steps; CTAs *Soutenir un équipage* and *Vérifier les preuves*.
2. **`/verifier`:** latest attestations list. **`/verifier/:eventId`:** a step-by-step checklist computed **in the browser** (lazy-load `nostr-tools` + `@noble/curves`): announcement fetched from relays ✓ · nonce committed before the window ✓ · signature valid ✓ · rule applied to the published data ✓ · each payment's proof (`sha256(preimage) = payment_hash`) ✓. Include a **"Pourquoi l'oracle ne peut pas mentir"** demo: one button signs two outcomes with a throwaway key and the same nonce, then shows the key being recovered.
3. **`/soutenir`:** choose the pool or a demo crew; amount presets in FCFA (2 000 / 5 000 / 10 000) with EUR equivalent; Lightning invoice QR; zap option; thank-you state with a link to the receipt.
4. **`/donnees`:** backtest bar chart (danger days per season per site, 1995–2025), the alert-day match table, how the premium is computed (one formula, plain words), data sources.
5. **`/e/:code`:** tiny crew status page (cover active? last payouts), < 30 KB, works on 2G.

CLPA dashboard:
6. **`/conseil`:** pool health, coverage ratio, 7-day danger strip per site, recent payouts, alerts (failed payouts, data outages).
7. **`/conseil/equipages`:** enrol a crew (pseudonym, site, Lightning address, phone; phone and address encrypted at rest), create premium invoice, policy status (waiting-period countdown, active, expired).
8. **`/conseil/rejeu`:** pick a site and a past alert date → runs the full pipeline with the demo oracle key and animates the `Timeline`: announcement → data → attestation → payouts → SMS. **This is the demo's money shot; make it beautiful.**
9. **`/conseil/parametres`:** thresholds, payout amount, loading, caps, waiting period.

### 10.5 Performance and accessibility budget
- Public pages: ≤ 120 KB JS gzipped on first load; verify page loads crypto libs lazily.
- Lighthouse (mobile, throttled): Performance ≥ 90, Accessibility ≥ 95.
- WCAG AA contrast; full keyboard navigation; `aria-live` on payment status changes.
- PWA: offline shell + last known status cached.

---

## 11. AI (small, useful, never touches money)
- **Daily sea bulletin** (French; English optional): generated from the attestation JSON, posted as a Nostr kind 1 note and shown on the home page. Template fallback when no API key.
- **Policy explainer** on the public site: answers questions like *"Est-ce que je suis payé si la mer est agitée l'après-midi ?"* strictly from the rules JSON; must answer "je ne sais pas" when outside the rules.
- Anthropic API, model from env `ANTHROPIC_MODEL` (default `claude-haiku-5-5`). The model output never reaches the payout engine.
- README includes an **AI-use disclosure**: what the product uses AI for, and that the code was built with Claude Code.

---

## 12. Backtest and pricing (`scripts/backtest.ts`, results in `data/seed/backtest.json`)
1. For each site, load ERA5-Ocean hourly wave height 1995–2025; compute the 06–18 UTC daily max.
2. Danger day = max ≥ threshold. Count per season (Kayar: Dec–Jun) and per year: mean, p90, worst.
3. Weekly premium per crew = `(mean danger days per season × payoutFcfa) ÷ weeks in season × (1 + loading)`, default loading 0.25.
4. Reserve target = worst season × active policies × payout.
5. **Alert-day check:** for these press-reported ANACIM alert dates, report whether the index fired at the named site: 2025-01-22 (Dakar coast), 2026-01-18 to 2026-01-20 (coast-wide), 2026-02-05 (Saint-Louis, Kayar), 2026-05-12 (Saint-Louis). Show a match rate. Treat the dates as "from press reports" in the UI.
6. Caveat to show: the backtest uses one reanalysis model while the live trigger uses two forecasts.

---

## 13. Build phases and checkpoints

**Phase 0 — Scaffold.** pnpm monorepo, strict TS, ESLint/Prettier, vitest, CI workflow, Dockerfile + docker-compose, `.env.example`, docs skeleton, Tailwind theme with the tokens. ✅ `pnpm test` passes; `docker compose up` serves a placeholder page.

**Phase 1 — `@ndox/oracle`.** Keys, announce, attest, verify, recoverKey, event (de)serialisation, all tests from §6.2. ✅ 100% of oracle tests green, including the `schnorr.verify` cross-check and key recovery.

**Phase 2 — Wave data and backtest.** Site config, fetchers (forecast + ERA5), raw-response hashing, trigger rule with tests, `pnpm data:fetch` writing seed files, `pnpm backtest` producing `backtest.json` + printed alert-day matches. ✅ Seed data committed; backtest table printed.

**Phase 3 — Server core.** Drizzle schema + migrations (sites, crews, policies, announcements, attestations, payouts, deposits, settings, notifications), scheduler jobs (§3) with `--dry-run`, Nostr publishing, public API. ✅ A dry-run of announce → fetch → attest works end to end on seed data.

**Phase 4 — Money.** Wallet interface, FakeWallet, NwcWallet, price service, policies + premiums, deposits, sponsor invoices, zap ingestion, payout engine with idempotency, pro-rata, caps, receipts. ✅ Tests for idempotency (double run pays once), waiting period, pro-rata, cap; a full replay pays FakeWallet crews.

**Phase 5 — Web.** Design system components, all public pages, dashboard pages, replay screen with animated timeline, in-browser verifier with the equivocation demo. ✅ Lighthouse budget met; Playwright smoke test of home → verify → sponsor (FakeWallet).

**Phase 6 — Notifications and AI.** Console + AT sandbox SMS, USSD menu, crew status page, bulletin + explainer with fallbacks. ✅ USSD works in the AT simulator; bulletin posts on dry-run.

**Phase 7 — Hardening.** Security headers (CSP, HSTS), rate limits, zod everywhere, PII encryption at rest (`PII_ENCRYPTION_KEY`), log redaction, `THREAT_MODEL.md` (table in §14), backup of the SQLite file, health-check pings (dead-man's switch after each job). ✅ Threat model reviewed against code; no PII in logs (grep test).

**Phase 8 — Live and docs.** Deploy (§15), run the live oracle, README (§16), screenshots, architecture diagram. ✅ Live URL, live attestations visible in a Nostr client, one real payout on the live wallet.

**Stretch (only after Phase 8 is green):** CLPA as a third signer (payout needs 2 of 3 attestations) · DLC TLV encoding · publish `@ndox/oracle` to npm · rain/drought module for farmers on the same engine · a single on-chain DLC proof of concept on regtest/Mutinynet · NIP-98 Nostr login for the CLPA.

---

## 14. Threat model (implement, then document in `docs/THREAT_MODEL.md`)

| Threat | Control |
| --- | --- |
| Oracle lies about the sea, or colludes with the payer | Two models must agree; nonce committed the evening before (equivocation leaks the key); raw data hashes published; roadmap: CLPA as a third signer (2-of-3) |
| Oracle key stolen | Oracle key separate from pool key and wallet; fresh random nonce per event, stored encrypted, deleted after use; key rotation announced on Nostr |
| Pool wallet drained | NWC connection with a wallet-side daily budget **and** app-side `DAILY_PAYOUT_CAP_SATS`; payouts only to destinations registered on the policy |
| Double payout | `UNIQUE(policy_id, attestation_id)`; invoice lookup before any retry |
| Buying cover after seeing the storm | 72 h waiting period |
| Ghost crews | Enrolment only through the CLPA dashboard |
| Personal data leaks | No PII on Nostr or in logs; salted hash commitments; phone and Lightning address encrypted at rest |
| Data outage or bad data | `indisponible` outcome = no trigger; minimum valid hours per model; dashboard alert |
| Pool too small for a fleet-wide storm | Pro-rata payouts; public coverage ratio and shortfall record; reserve target from the worst backtest season |
| Replay confused with live | Separate demo oracle key, `ndox-replay` tag, *Rejeu* badge |
| Admin takeover | Hashed admin password, httpOnly secure cookie, rate-limited login, CSRF protection |

Honest limits for the README: basis risk (grid-cell forecast ≠ the beach); both models come through one provider (Open-Meteo, free for non-commercial use); custody in the MVP (roadmap: on-chain DLC); regulation (CIMA zone; framed as the CLPA's own mutual fund, licensed insurer later); cash-out simulated.

---

## 15. Make it live

**Hosting:** any of Fly.io (with a volume for SQLite), Railway, or a small VPS with `docker compose` + Caddy for HTTPS. One container serves API + web + scheduler.

**Wallet:** a live NWC connection with a hard budget (suggested total exposure ≤ 50,000 sats). Options: Alby Hub (self-hosted or cloud) or another NWC wallet. Docker's default is `WALLET_MODE=fake`; the live deployment uses `WALLET_MODE=nwc`. Show the network (`mainnet` / `mutinynet`) in the footer.

**Demo crews:** 10 per site, each with a team-controlled Lightning address, labelled *Démo*.

**Uptime through judging (Nov 21–26):** health-check pings after each job (e.g. healthchecks.io), alert on a missed ping, daily SQLite backup.

`.env.example`:
```
NODE_ENV=production
PORT=8080
PUBLIC_BASE_URL=https://ndox.example.com
DATABASE_PATH=/data/ndox.sqlite
ORACLE_SECRET=            # hex, 32 bytes
DEMO_ORACLE_SECRET=       # hex, 32 bytes, replay only
POOL_SECRET=              # hex, 32 bytes
WALLET_MODE=fake          # fake | nwc
NWC_URL=                  # nostr+walletconnect://... (budget-capped)
NETWORK_LABEL=mainnet     # mainnet | mutinynet | regtest
DAILY_PAYOUT_CAP_SATS=20000
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net
DEFAULT_THRESHOLD_M=2.5
PAYOUT_FCFA=2000
WAITING_HOURS=72
PREMIUM_LOADING=0.25
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
PII_ENCRYPTION_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-5-5
AT_USERNAME=sandbox
AT_API_KEY=
HEALTHCHECK_URL=
```

---

## 16. README (judges read this first)
1. One-line pitch + tagline, live URL, 3-min video link, screenshot of the home page.
2. **Quick start:** `cp .env.example .env && docker compose up` → open `http://localhost:8080` (FakeWallet + seed data). Then `pnpm replay --site kayar --date 2026-02-05`.
3. The problem (with sourced numbers) and the primary user's day before/after.
4. How it works + architecture diagram (Mermaid).
5. **Why the oracle can't lie** (the maths in 6 lines, link to tests).
6. **Réel vs simulé** table.
7. Threat model summary + honest limits.
8. Backtest results and alert-day match rate.
9. Metrics to track: crews covered, payout latency (attestation → paid), alert-day match rate, coverage ratio.
10. Roadmap: CLPA co-signer → licensed partner pilot → Wave cash-out → on-chain DLC → farmers' rain module.
11. AI-use disclosure, licence (MIT), sources.

---

## 17. Demo script (for reference while building the UI)
| Time | On screen | Line |
| --- | --- | --- |
| 0:00–0:25 | An ANACIM alert headline; the deaths figure | "When ANACIM raises the red flag, fishers still go out. Not because they don't know. Because they have to eat." |
| 0:25–0:45 | `/conseil`: pool, crews, coverage ratio | "Kayar's council already collects 200 FCFA per fuel purchase for sea accidents. Ndox turns that pot into automatic protection." |
| 0:45–1:10 | Enrol a crew; premium invoice paid; policy appears on Nostr | "No app for the fisher. A relative abroad can top up the pool from any Lightning wallet." |
| 1:10–1:50 | `/conseil/rejeu` on 2026-02-05 (confirm the data crosses 2.5 m first) | "Two models agree, the oracle signs, everyone covered is paid before sunrise." |
| 1:50–2:20 | `/verifier/:eventId` checklist + equivocation demo | "You don't have to trust us. Anyone can re-check the forecast, the signature and every payment." |
| 2:20–2:40 | `/donnees` backtest | "The price comes from decades of wave data, not a guess." |
| 2:40–3:00 | Roadmap | "Quand la mer dit non, Ndox paie." |

---

## 18. Definition of done
- [ ] `docker compose up` on a clean machine starts everything with seed data and FakeWallet.
- [ ] The 2026-02-05 replay (or another confirmed alert day) runs end to end and pays.
- [ ] Live deployment: public URL, oracle publishing daily to relays, at least one real Lightning payout.
- [ ] Verify page re-checks a live attestation in the browser, including payment proofs.
- [ ] Backtest chart and alert-day match rate on `/donnees` and in the README.
- [ ] Threat model, *Réel vs simulé* table and AI disclosure in the README.
- [ ] All tests green in CI; Lighthouse budget met.
- [ ] Wolof strings either reviewed by a native speaker or hidden.
- [ ] Public repo, MIT licence, first commit dated during the event.
