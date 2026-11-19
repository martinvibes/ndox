# Decisions log

One line each: date · decision · why. Where the brief left something open, the simplest option consistent with it was chosen.

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-19 | Live models are `ecmwf_wam` (ECMWF WAM, 9 km, hourly, data from Nov 2025) and `ncep_gfswave025` (NCEP GFS-Wave 0.25°, hourly, global). | IDs verified against the live API. `ecmwf_wam025` is 3-hourly (4 values in a 12 h window, below the 10-valid-hours rule). |
| 2026-11-19 | Backtest model is `era5_ocean` (ERA5-Ocean, 0.5°, 1940–present). | Verified against the live API. |
| 2026-11-19 | Saint-Louis offshore point moved from -16.60 to **16.02, -16.70**. Kayar 14.95,-17.20, Joal 14.15,-16.95, Soumbédioune 14.68,-17.50 unchanged. | At -16.60 the GFS-Wave 0.25° cell (16.00,-16.50) returns `0.00` m every hour (land cell; zeros, not nulls). |
| 2026-11-19 | A model window whose valid values are all exactly `0` counts as **no valid hours**. | Land cells return 0.00 instead of null; treating that as "calm" would silently suppress payouts. |
| 2026-11-19 | Attestation tag confirmed as `DLC/oracle/attestation/v0`; outcomes are NFC-normalised UTF-8. | dlcspecs Oracle.md: `Sign(sk, msg, tag) = BIP340_sign(sk, tag_hash("DLC/oracle/" ‖ tag)(msg))`, tag `attestation/v0`, NFC UTF-8 outcomes. |
| 2026-11-19 | Oracle signing is tested against the official BIP340 vectors 0–3 (byte-identical signatures with the BIP340-derived nonce). | dlcspecs Oracle.md publishes no attestation test vectors. |
| 2026-11-19 | Demo replay date is **2026-02-27 (Kayar)**, not 2026-02-05. | On 02-05 neither model crosses 2.5 m at the Kayar grid point (ECMWF 2.32 m, GFS 1.90 m). 02-27 is inside ANACIM's special bulletin of 24 Feb 2026 (Grande Côte from 26 Feb 06:00, "pouvant dépasser 2,5 m") and both models cross (2.86 m / 2.62 m). 02-05 stays in the alert-day check as an honest miss. |
| 2026-11-19 | Kind 88 `rule` also carries `minValidHours`; kind 88 also has the draft NIP-88 `relays`, `title` and `description` tags. | Lets any verifier re-apply the full rule; closer to the draft without claiming compliance. |
| 2026-11-19 | Nostr events in `@ndox/oracle` are signed/verified with `@noble` directly (NIP-01). `nostr-tools` is used for relay I/O and as a cross-check in tests. | Keeps the publishable package free of non-crypto dependencies. |
| 2026-11-19 | Replay event ids are `ndox-replay:<site>:<date>:<runId>`, tagged `t=ndox-replay`, signed by `DEMO_ORACLE_SECRET`. | Each replay run needs a fresh nonce and must never collide with a live event id. |
| 2026-11-19 | `recoverKey` returns the BIP340-normalised secret (x or n − x). | Both control the same x-only public key, so the recovered key is equally able to sign as the oracle. |
| 2026-11-19 | TypeScript pinned to 6.0.x. | TypeScript 7 (native) is not yet supported by typescript-eslint. |
| 2026-11-19 | Router is `wouter` (~2 KB) rather than react-router. | 120 KB first-load JS budget. |
| 2026-11-19 | Server is bundled with esbuild (workspace packages inlined, third-party deps external). | One `node dist/index.js` in the container; no TS loader at runtime. |
| 2026-11-19 | Empty secrets are auto-generated and persisted in the data directory when `WALLET_MODE=fake`; `WALLET_MODE=nwc` refuses to start without every secret. | `cp .env.example .env && docker compose up` must work on a clean machine without weakening the live deployment. |
| 2026-11-19 | The trigger variable is `wave_height`. `swell_wave_height` is stored when a model provides it and shown in the backtest from GFS-Wave only. | Through Open-Meteo, ERA5-Ocean and ECMWF WAM return `null` for `swell_wave_height`; only GFS-Wave provides it, so a swell trigger could never satisfy the two-model rule. |
| 2026-11-19 | Saint-Louis uses an ERA5-only backtest point at **16.02, -17.00**. | ERA5's 0.5° cell for (16.02, -16.70) is centred on the coast (16.0, -16.5) and damped: 0 days ≥ 2.0 m in 2024 vs 38 one cell offshore. |
| 2026-11-19 | The alert-day list adds ANACIM's special bulletin of 24 Feb 2026 (26, 27, 28 Feb, all affected sites, misses included). | Found while confirming the demo day; all three days are listed to avoid cherry-picking. |
| 2026-11-19 | The backtest adds a threshold calibration table (2.0–3.0 m: alert match rate, danger days, premium). The default stays 2.5 m. | At 2.5 m the index matches 15 % (ERA5) / 8 % (live rule) of press-reported alert site-days; at 2.0 m it is 69 % / 40 % but the Kayar premium quadruples. Calibration is the CLPA's call, shown on /donnees. |
| 2026-11-19 | Seeds store compact daily 06–18 UTC maxima (+ valid hours) and per-request SHA-256; raw ERA5 yearly responses stay in `data/raw/` (git-ignored). Replay forecasts are stored raw with URL, fetch time and SHA-256. | 32 MB of raw ERA5 would bloat the repo; replays must be re-verifiable byte for byte. |
