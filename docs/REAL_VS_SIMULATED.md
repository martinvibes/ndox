# Réel vs simulé

Anything simulated carries a visible **Simulé** badge in the UI.

| Part | Status | Notes |
| --- | --- | --- |
| Wave data (Open-Meteo: ECMWF WAM + NCEP GFS-Wave, ERA5-Ocean history) | **Réel** | Raw responses hashed (SHA-256) and the hashes published in each attestation. |
| Oracle signatures (BIP340 Schnorr, pre-committed nonce) | **Réel** | Tested against official BIP340 vectors. |
| Nostr publishing (kinds 88/89/30078/1) | **Réel** when `NOSTR_PUBLISH=true` | Docker default signs but does not publish (dry run). |
| Lightning wallet | **Simulé** by default (`WALLET_MODE=fake`), **réel** with `WALLET_MODE=nwc` | FakeWallet makes BOLT11-shaped invoices whose preimages hash to the payment hash. |
| Crews | **Démo** | Équipages de démonstration with team-controlled Lightning addresses. No real fisher is enrolled. |
| SMS | **Simulé** (console) or Africa's Talking **sandbox** | |
| USSD | Africa's Talking **sandbox** | |
| Mobile-money cash-out (Wave / Orange Money) | **Simulé** | Interface only; no real API calls. |
| Replays of past days | **Rejeu** | Separate demo oracle key and `ndox-replay` tag. |
