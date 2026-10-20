# HUQAN Demo Positioning

## Demo Goal

The demo should make one thing obvious: HUQAN judges claims, it does not merely echo them.

## Demo Narrative

Use a short sequence that shows:

1. Teach or ingest a fact.
2. Verify a supported claim.
3. Verify an unsupported claim.
4. Verify a contradiction.
5. Show the receipt or reasoning trace when available.

## Demo Language

Use:

- `local-first`
- `deterministic`
- `graph-backed`
- `receipt`
- `gate`

Avoid:

- `guaranteed truth`
- `hallucination-free` as an absolute claim
- `fully autonomous`
- `production-scale graph`
- `full NLP engine`

## Two Audiences, Two Messages

Two messages lead the same product to two audiences. Use one per page; do not blend them, and do not put price or licensing language here (out of scope for this document).

### Individual / community — "your agent's emergency brake"

The solo developer does not want a SOC 2 program. They want the agent stopped before it does harm, and a plain yes or no.

Message: **HUQAN: your agent's emergency brake.**

Backed by: a mutating call is held for a person's approval before it runs — the gate returns `REVIEW`, not `BLOCK`, so the call is paused rather than refused — and `huqan.emergency_stop` stops one agent or a whole workspace. The public demo makes the hold visible: REVIEW -> human approval -> execution.

Use on: the community page, the README opening, the static demo landing.

### Enterprise — "an independent auditor" (collector-backed)

Even when a platform embeds its own audit, the organization does not trust the record kept by the party that took the action. The auditor rejects the suspect's own ledger.

The word has a deployment condition, so state the default claim and the collector-backed claim separately.

- Default (today, no collector deployed): **the audit record is not written by the agent.** Receipts are produced by the gate that made the decision, held locally, and verifiable from the receipt itself, so the record of an action is not the agent's own account of it.
- Collector-backed (a collector runs where the operator does not administer it): **an inspector does not accept the ledger the suspect kept.**

Use on: the enterprise page and the README enterprise paragraph. Until a collector is deployed, lead with the default claim and keep "independent auditor" for the collector-backed case.

### The boundary of "independent" (non-claim)

"Independent" is true only as far as the counter-seal goes, and the limit is written down in the code:

- An issuer signature proves a receipt's **origin and integrity, not operator honesty**. Whoever holds the issuing key can edit the trail, re-sign it, and ship a clean history where every signature verifies (`lib/receipt/issuer-seal.js`).
- Independence needs a **collector counter-seal**: a statement signed with a key the audited host does not have, held by a party the operator does not administer (`lib/receipt/collector-seal.js:22-25`).
- Both keys on one machine means one person holds both ends, and the seal then detects accidental corruption and nothing more.

So the enterprise message may claim an independently *verifiable* record. It may not claim an independent *auditor* until a collector runs somewhere the operator does not administer. Until then, state the non-claim in the same breath as the message.

## Demo Surface

The public demo should be clearly labeled as a static concept surface when it is not connected to a live backend.

The local UI should be positioned as the backend-connected developer surface.

## Short Closing

Models generate. Agents act. Memory stores. HUQAN judges.
