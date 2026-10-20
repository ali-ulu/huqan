# GITHUB-APP-TRUST-LOOP-2 — Check Conclusion Semantics, and Why C8 Needs No Derivation Signal

Issue: #4091 (ENT-TL7, optional derivation-verification signal for C8).
Decided in: #4086 (ENT-TL3, what the C8 `success` conclusion claims).
Implemented in: PR #4098, merged as `72264b41d01ee5d850cf4e23b1e0dafe0dcc07f6`.

Mode: docs-only decision record. No production code, contract, or permission
change follows from this document.

## Goal

Record the C8 check-run conclusion semantics that #4086 decided, and close the
optional follow-up #4091 by showing that the decision already removed the
reason that follow-up existed.

## The decision (#4086, option A)

The C8 Streaming Trust check run reads metadata only: the changed-file list,
its per-file status, and addition/deletion counts. It never reads patch
content. A green check therefore reads as "verified" to a human, which is a
claim the evidence does not support.

Option A was selected:

| canonical verdict | check conclusion | check title |
| --- | --- | --- |
| `allow` | `neutral` | `HUQAN: no blocking signal (metadata only)` |
| `review`, `dry_run_only` | `action_required` | unchanged |
| `block` | `failure` | unchanged |

The table is not a total mapping of the canonical verdict set. The canonical
verdicts in `lib/verdict/action-verdict.js` are `allow`, `review`, `block`,
`dry_run_only`, `quarantine`, and `disabled`. `quarantine` and `disabled` are
rejected by `checkConclusion()` with `INVALID_INPUT` — they are not projectable
to a check conclusion, so they have no row above.

The invariant that matters for this record: **C8 never emits `success`.**
`checkConclusion()` in `lib/github-app-streaming-trust-receipt.js` returns
`neutral` for `allow`, and no code path in the C8 write-back path returns
`success` for any verdict. The canonical verdict set in
`lib/verdict/action-verdict.js` is unchanged; only the GitHub check
projection changed.

## Why the derivation signal is not needed

Option C — "emit `success` only when the ENT-TL7 derivation verification also
passes" — was the only option that needed a derivation-verification
integration inside C8. Option A does not, for three reasons.

1. **Option A removed the claim that derivation would have to support.**
   Under option C, `success` would mean "the change was checked and it holds".
   Under option A, `success` is not a reachable conclusion, so there is nothing
   left for a derivation check to license. The signal would have been an
   enabler for a conclusion that no longer exists.

2. **Derivation could only ever weaken the conclusion, never strengthen it.**
   The #4091 design bound the effect to one direction: a `failed` derivation
   raises the verdict to at least `review`; a `verified` derivation never
   produces `allow` on its own. A signal that can only subtract cannot rescue
   a `success` conclusion that option A has already removed. Its only remaining
   effect would be to turn `neutral` into `action_required` in some cases —
   that is a new claim about a PR's safety, and it is not one C8's metadata
   evidence can support either.

3. **C8's write-back path is not authorized to read patch content.** C8 reads
   the changed-file list and the per-file metadata only
   (`lib/github-app-streaming-trust-github-api.js`). Derivation verification
   reads file content at a ref (`fetchFileAtRef` in
   `lib/pr-guardian/derivation-fetch.js`), which would require widening the
   installation token to `contents: read` beyond the `checks: write` /
   `pull_requests: read` the C8 token carries today
   (`lib/github-app-streaming-auth.js`). #4091 named that permission widening
   as an open question, and it stays open: the decision in #4086 means nothing
   asks for it.

## What the derivation surfaces already are

The repository is not short of derivation verification; it has two, and neither
is C8.

- PR Guardian runs the derivation check over a snapshot and summarizes it as
  `none` / `verified` / `failed` / `unknown`
  (`lib/pr-guardian/derivation-check.js`, `summarizeDerivations`).
- The Coder side re-derives a patch and compares it against the tree
  (`lib/coder/verify-derivation.js`), which is a different artifact from the
  C8 changed-file metadata.

Both live outside the C8 write-back path. Option A did not remove them, did not
weaken them, and did not move them. C8 stays a metadata-only gate; PR Guardian
stays the surface that re-derives patches.

## Constraints on any future derivation integration

Should a later, separately justified decision ask for derivation evidence to
appear in a GitHub check conclusion, the following constraints already hold and
are recorded here so that decision does not have to re-derive them.

1. **The no-`success` invariant survives.** A future derivation signal may
   change which conclusion is written, but it must not make `success`
   reachable for metadata-only evidence. `checkConclusion()` is the single
   place that decides this, and the test
   `an allow verdict from metadata-only evidence is never shown as success`
   (`test/v5-c8-streaming-trust.test.js`) is the pin.
2. **Reuse, do not rewrite.** The derivation logic already exists as pure
   functions: `lib/pr-guardian/derivation-check.js` (summarizing) and
   `lib/pr-guardian/derivation-fetch.js` (collecting, `collectDerivations` with
   its `maxRecords` bound). A future integration calls them; it does not
   reimplement them inside the streaming path.
3. **Stay inside the existing budget.** The C8 evaluation window is
   `DEFAULT_BUDGET_MS` in `lib/github-app-streaming-trust-contract.js`, and the
   fetch side is bounded by `maxRecords`. A derivation read that cannot fit
   those bounds is declined, not awaited.
4. **Any new dependency is a layer decision.** If a future integration needs a
   module that does not exist yet, it must satisfy `scripts/check-layers.js`,
   or the exception must be documented in the same way the existing ones are.

## Consequence for #4091

#4091 was explicitly conditional: "only if option C is selected in ENT-TL3".
Option C was not selected. The prerequisite named by the issue was therefore
never met, and the integration it described is not required.

#4091 is closed as resolved-by-decision. Nothing in this record authorizes
code work, a permission widening, or a change to the C8 verdict projection.

## What this record does not claim

- It does not claim that derivation verification is worthless. It is a real
  check, on a different surface (PR Guardian, Coder), and it stays there.
- It does not claim that `neutral` is a stronger signal than `action_required`.
  It is a weaker one, and honestly so: it says "no blocking signal in
  metadata", not "this change is safe".
- It does not decide whether a future product decision should make C8 a
  required branch-protection check. #4086 left that open, and it stays open.

## Evidence

- #4086 — the decision, option A, owner decision 2026-10-20.
- PR #4098 — the implementation: `lib/github-app-streaming-trust-receipt.js`
  (`checkConclusion`), `lib/github-app-streaming-trust-check-run.js` (the
  metadata-only check title), and the C8 test updates.
- #4091 — the conditional follow-up this record closes.

