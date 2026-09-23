# Contested-claim read policy

Phase 1 of [#2788](https://github.com/ali-ulu/huqan/issues/2788), implementing
the design finalized in that issue's two decision comments
([issuecomment-5784967135](https://github.com/ali-ulu/huqan/issues/2788#issuecomment-5784967135),
[issuecomment-5784993182](https://github.com/ali-ulu/huqan/issues/2788#issuecomment-5784993182)).

## The problem

A claim can enter a contested state -- a candidate claim from
`lib/conflict-detector.js` conflicts with an existing canonical record and is
flagged for human triage (`recommendation: 'flag'`, `status: 'pending'`). Until
triage resolves it, nothing previously defined what a *read* of that claim
returned. This module makes that read behavior explicit, and scopes it by the
risk of what the reader is about to do with the value.

## What counts as "contested"

`isContestingCandidate` (`lib/contested-read-policy.js`) is true only for a
candidate that:

- carries a real conflict object from `lib/conflict-detector.js`
  (`candidate.conflict?.conflict === true`) -- not merely
  `recommendation === 'flag'`, which `lib/graph-hypotheses.js` (diagnosis
  candidates) and `lib/external-client-mutation-receipt-owner.js` (review-hold
  candidates) also use for non-conflict candidates with no conflict object at
  all;
- is still flagged and unreviewed (`recommendation === 'flag'`, `status` is
  neither `'accepted'` nor `'rejected'`);
- actually targets the canonical record being read
  (`matchesCanonicalTarget`, `lib/canonical-target-match.js`).

Web-research contradiction signals, including `SEMANTIC_OPPOSITION`,
are now covered when candidate mode is enabled. #2144 stores the external
research result as a live pending candidate and #2146 records provenance-bound
opposition targets inside that candidate. `matchesCanonicalTarget` therefore
sees the contested canonical edge without treating the external statement as
canonical truth.

The boundary remains narrow: only a stored live candidate can contest a read.
A transient contradiction-rules result that was never admitted to the
candidate store still has no effect on this policy.

## Read behavior by risk class

When a target *is* contested, the caller's declared risk (`intent`) selects
how the read is served:

| Reader risk level (#2505 bands) | Example categories | Behavior |
|---|---|---|
| LOW | `READ_ONLY` (dashboards, `ask`/`verify`) | `contested_marker` -- both sides returned, no settled value |
| MEDIUM | `FILESYSTEM_WRITE`, `NETWORK_CALL`, `SANDBOX_SIMULATION` | `last_known_good` -- the pre-contest canonical value |
| HIGH | `MEMORY_WRITE`, `CANONICAL_GRAPH_WRITE`, `CODE_CHANGE`, `TOOL_CHAIN_EXECUTION` | `block` |
| CRITICAL | `PRODUCTION_MUTATION`, `PERMISSION_CHANGE`, `DEPLOYMENT`, `SECURITY_POLICY_CHANGE` | `block` |
| missing/unrecognized intent | legacy callers | `block` (fail-safe, matching `docs/action-taxonomy.md` §4's unknown-category rule) |

Risk is resolved with #2505's existing taxonomy
(`lib/risk-policy-constants.js`, `lib/risk-scale.js`, `lib/blast-radius.js`) --
no second scale is introduced. `intent` may supply `category`, `riskScore`
(0-100), and/or `blastRadius` (a `computeBlastRadius()` result); when more
than one resolves, the highest level wins.

**MEDIUM stays `last_known_good` rather than collapsing into `block`.** The
risk that the challenger turns out to be correct (so a MEDIUM action runs on
stale data) is real, but #2505's taxonomy has four bands, not two, precisely
so non-critical automation can keep moving on stale-but-not-nothing data while
HIGH/CRITICAL cannot. The mitigation is the same one HUQAN already uses
elsewhere for an unresolved-trust case (`lib/memory-recall-gate.js`'s
`degrade`): never silent. Every `last_known_good` read appends a
`claim_read_last_known_good` ledger event, so the read is auditable after the
fact even though it was not blocked.

**No last-known-good escalates to `block`.** If the mapped behavior is
`last_known_good` but there is no canonical record to serve, the read
escalates to `block` with `reason: 'no_last_known_good'` rather than serving
nothing under a behavior name that promised a value.

## Why a new return type, not a Trust Receipt field

`specs/axiom-trust-protocol/0.1/schemas/trust-receipt.schema.json` requires
`claim: string` and is frozen for 0.1. A contested or blocked read cannot be
expressed by omitting or nulling a receipt field, and an optional
`contested: true` flag on the normal shape is easy for a caller to silently
ignore -- exactly the failure mode #2788 raised. `lib/claim-read.js` instead
returns a frozen, discriminated union (`kind: 'settled' | 'unsettled' |
'not_found'`). Reaching a value from an `unsettled` result requires calling
`unwrapClaimRead(result, { accept: [...] })` and naming which degraded
behaviors the call site is willing to act on -- so ignoring the contested
state becomes a visible code decision, not a silent default. `block` never
unwraps, regardless of `accept`.

The union member for a degraded read is named `unsettled`, not `contested`:
Ali's write-side follow-up on #2788 (an admission-time reverification horizon
for canonical writes, expected as its own issue) wants an expired-canonical
record to resolve to this same shape with a different `reason`
(`authority_expired`, already reserved in `UNSETTLED_REASONS`). A neutral name
means that composes as an additive reason, not a breaking rename.

## `block` receipts carry only id + status

A `block` result's `receipt` field is `{ id, status }`, not the full embedded
Trust Receipt -- which includes the challenger's claim text as evidence. That
evidence is for a human triaging the conflict, not for an automated
HIGH/CRITICAL-risk caller whose own risk class says not to act on it.
`contested_marker` (the LOW/dashboard case) keeps the full `receipt` and a
`sides: { canonical, challengers }` payload, since that is exactly the
audience meant to see both claims side by side.

## What this does not do yet

- **No triage-resolution path for conflict candidates.** `block` is permanent
  until the underlying candidate is reviewed, and nothing in this repository
  currently reviews a conflict-detector candidate (`lib/hypothesis-review.js`
  only covers hypothesis candidates). This is a hard prerequisite before any
  Phase 2 surface exposes `readClaim` to a real caller -- tracked as a
  follow-up, separate from this issue.
- **No surface wiring.** `lib/claim-read.js` is library-only in this phase;
  nothing in `server.js`, `mcpServer.js`, or the MCP tool catalog calls it
  yet (see `lib/module-reachability.js`'s `NOT_YET_WIRED` entries for
  `lib/claim-read.js` and `lib/contested-read-policy.js`). Phase 2 exposes it
  over HTTP (`lib/http-trust-query.js`, which has headroom) rather than as a
  new MCP tool, since `lib/mcp-tool-catalog.js` is already at its line-budget
  ceiling.
- **No write-side horizon.** Ali's admission-time reverification follow-up is
  scoped as its own issue; `reason: 'authority_expired'` is reserved here so
  that work composes into the same shape without a rename.
