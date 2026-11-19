# @ndox/oracle

A tiny DLC-style oracle: BIP340 Schnorr attestations with a **pre-committed nonce**, published over Nostr using the draft NIP-88 kinds (`88` announcement, `89` attestation). Depends only on `@noble/curves` and `@noble/hashes`.

> Uses NIP-88 kinds and DLC-style signatures; content is JSON. DLC TLV encoding is on the roadmap. This is not a full NIP-88 implementation.

## Why the oracle can't lie

1. The evening before, the oracle publishes `R = k·G` (the nonce point) for tomorrow's event.
2. At dawn it signs the outcome `m = taggedHash("DLC/oracle/attestation/v0", outcome)`:
   `e = H_BIP0340/challenge(R ‖ P ‖ m)`, `s = k + e·x`.
3. Anyone checks `s·G = R + e·P` (standard BIP340 verify) **and** that `R` is the announced one.
4. If it signs two outcomes with the same `R`: `s₁ − s₂ = (e₁ − e₂)·x`, so
   `x = (s₁ − s₂)/(e₁ − e₂) mod n` — anyone can compute the oracle's private key.
5. So an oracle that equivocates destroys itself. `recoverKey()` implements step 4.

## API

```ts
import {
  generateNonce, attest, verifyAttestation, recoverKey,
  buildAnnouncement, buildAttestation, verifyAttestationEvent,
} from '@ndox/oracle';

const nonce = generateNonce();                 // keep nonce.k secret, publish nonce.noncePoint
const ann = buildAnnouncement({ secret, site: 'kayar', date: '2026-11-20', noncePoint: nonce.noncePoint, rule, createdAt });
const att = buildAttestation({ secret, announcement: ann.event, nonceK: nonce.k, outcome: 'danger', data, createdAt });
const report = verifyAttestationEvent(ann.event, att.event, { expectedOraclePubkey });
report.ok; // every check passed
```

`verifyAttestationEvent` returns a step-by-step report (`announcement_signature`, `attestation_signature`, `known_oracle`, `same_oracle`, `linked`, `nonce_committed_before_window`, `nonce_matches`, `outcome_announced`, `oracle_signature`). The Ndox payout engine and the public in-browser verifier run this same function.

## Tests

`crypto.test.ts` checks byte-identical signatures against the official BIP340 test vectors (0–3), a `schnorr.verify` cross-check, odd-Y handling for both `P` and `R`, and key recovery from equivocation. `events.test.ts` cross-checks every event with `nostr-tools`.

MIT
