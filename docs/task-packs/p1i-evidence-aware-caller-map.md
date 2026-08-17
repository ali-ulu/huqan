# P1-I — Evidence-unaware callers: classification and seam search

## Purpose

Steps 2–4 of the agreed order. P1-H established that fifteen of twenty-one
chokepoint writes discard the audit result, so the unit is the **caller
contract**, not the sink. This classifies those callers, and asks whether a
common batch audit-gap accumulation seam already exists before any is added.

The decided contract, which this does not re-open:

```text
batch / transactional  -> accumulate during, one visible result at the end,
                          retrySafe: false, no claim of undoing committed writes
single PRE             -> fail-closed evidence path
single POST            -> visible / reporting path per caller contract
```

**Nothing is changed here.**

## Canonical base

```text
repository: ali-ulu/huqan
main: 9b8b385fa16aa6f2453bbbe680bd5e97b603b96c
```

## Result 1 — fifteen sites are five callers

The fifteen discarding sites do not need fifteen decisions. They collapse into
**five functions**:

| Caller | Sites | Shape | Return shape |
|---|---|---|---|
| `kernel.js` `learn` | 1 (`:796`) | single, PRE | throws `ProvenanceError` |
| `kernel.js` `_crossLink` | 1 (`:912`) | **batch** (loop) | `{ written, audits, skipped }` |
| `lib/learn-use-case.js` `executeLearn` | 7 (`:30, 49, 77, 233, 261, 293, 334`) | **batch** — 3 PRE, 4 POST in loops | `{ learned, skipped, conflicts, ... }` |
| `lib/conflict-detector.js` `acceptCandidateClaimJournaled` | 2 (`:412, 453`) | **transactional** (`runMutationOnce`) | `{ candidate, conflict, warnings, admission }` |
| `lib/conflict-detector.js` `routeCandidateClaim` | 4 (`:549, 570, 589, 603`) | **batch** | `{ candidate, conflict, warnings }` |

So step 5's scope is four batch/transactional callers and one single PRE
caller — not fifteen separate contracts. That is a materially smaller unit
than the site count suggested, and it is the first time the work has got
smaller rather than larger across these measurements.

## Result 2 — the precedent is half-broken

`_crossLink` was named as the working precedent for "count evidence rather than
throw". Measuring it shows the precedent does not hold in its own function.

It has two branches incrementing the same `audits` counter:

```js
// parent-allowed branch (kernel.js:912)
this._appendAuditEvent({ ... }, parentProvenance, workspaceId);
audits++;                                   // unconditional

// background branch (kernel.js:935)
const result = this._commitBackgroundEdge(...);
if (result.audit) audits++;                 // evidence-aware
```

Run with a throwing audit sink, everything else intact:

```text
crossLink live: {"written":1,"audits":1,"skipped":0}
crossLink dead: {"written":1,"audits":1,"skipped":0}
```

**`audits: 1` with no audit written.** The counter reports evidence that does
not exist.

This is worth stating carefully, because it is the difference between a gap and
a wrong answer. Elsewhere in this family a failed audit produces *silence* —
bad, and ADR-012's forbidden B3. Here it produces a *false positive*: a caller
asking "how many audit records did this derivation produce?" is told one, and
there are none. A silent gap can be discovered later by comparing counts; this
cannot, because the count agrees with the wrong answer.

It also removes the argument that `_crossLink` shows the shape to copy. Half of
it does. The half that was cited as precedent is the half that is wrong.

## Result 3 — no accumulation seam exists

Searched for an existing mechanism the four batch/transactional callers could
accumulate into. There is one reconciliation mechanism in the repository and it
does not fit:

`lib/workbench/ingest-approval-audit.js::auditEvidenceGap` produces exactly the
semantics the decision calls for — bounded, `retry: false`, identifiers for
manual reconciliation, no claim of undoing a committed write. But its shape is
HTTP:

```js
return {
  status: 409,
  json: { ok: false, status: 'reconciliation_required',
          error: { code: 'AUDIT_EVIDENCE_MISSING', message },
          reconciliation: { approvalId, receiptId, decision, actionOutcome, committed, retry: false } },
};
```

It requires an `approval` and a `receipt`, and returns a transport response.
None of the four callers has either; three return plain result objects
(`{ candidate, conflict, warnings }`, `{ written, audits, skipped }`,
`{ learned, skipped, ... }`) and none is at a transport boundary.

```text
COMMON_ACCUMULATION_SEAM_EXISTS = false
NEAREST_EXISTING_MECHANISM      = lib/workbench/ingest-approval-audit.js (HTTP-shaped)
REUSABLE_AS_IS                  = false
REUSABLE_SEMANTICS              = yes
```

The distinction matters for step 4's instruction to use the smallest existing
mechanism before adding an abstraction. What is reusable is the **vocabulary
and the rules** — `AUDIT_EVIDENCE_MISSING`, `retry: false`, "committed, not
undone", identifiers over raw errors. What is not reusable is the **return
shape**, because it is a 409 response and these are internal calls.

So the minimum honest step 5 is not "reuse `auditEvidenceGap`" and not "invent
a general audit framework". It is: accumulate per batch, and report the gap in
each caller's own return shape using the existing vocabulary.

## Result 4 — what each caller's return shape already offers

None of the four needs a new outcome type; each has a natural place for the
gap.

| Caller | Existing field to extend | Note |
|---|---|---|
| `_crossLink` | `audits` | already present, and currently wrong — fixing it is the same edit |
| `executeLearn` | result object with `learned`, `skipped`, `conflicts`, `provenanceWarnings` | already carries a warnings channel |
| `acceptCandidateClaimJournaled` | `warnings` | present |
| `routeCandidateClaim` | `warnings` | present |

Three of four already return a `warnings` channel, and the fourth returns a
counter that is supposed to mean exactly this. That is why "one common
accumulation seam" is probably the wrong shape to build: the accumulation is
per-batch and local, and the reporting surface already exists in each caller.

## Verdicts

```text
EVIDENCE_UNAWARE_CALLERS            = 5      (15 sites)
BATCH_OR_TRANSACTIONAL_CALLERS      = 4
SINGLE_PRE_CALLERS                  = 1      (kernel.learn)
COMMON_ACCUMULATION_SEAM_EXISTS     = false
CROSSLINK_PRECEDENT_HOLDS           = false  (over-reports; measured)
CALLERS_WITH_EXISTING_REPORT_FIELD  = 4 of 4
NEW_ABSTRACTION_REQUIRED            = not demonstrated
```

## What follows

The measurement supports a smaller first implementation than the plan assumed,
and one correction to it.

**Correction:** the plan's step 5 lists "1 ortak accumulation/finalization
mekanizması". This measurement does not support building one. Four callers,
four existing report channels, no shared transport — a common mechanism would
be an abstraction over four call sites that already have somewhere to put the
answer. The shared thing that genuinely exists is the *vocabulary*, and that
can be a small constants module rather than a seam.

**Supported first unit:** `_crossLink`. It is one caller, one site, its
counter is already wrong in a way that is demonstrated rather than argued, and
fixing it requires no new type — the `if (result.audit)` form from its own
other branch is the fix. It converts a false positive into a true count, which
is a strictly stronger outcome than converting silence into a warning, and it
does it in the smallest possible diff.

Then the three remaining batch callers, each reporting through the `warnings`
channel it already returns.

This document does not decide that order. It records that the evidence
supports it and that it contradicts one line of the current plan.

## What this does not claim

- It does not claim `_crossLink`'s two branches should stay two branches. They
  should probably converge; that is a separate question from the counter.
- It does not claim `warnings` is the right channel for all three. Each
  caller's consumers were not audited here.
- It does not re-open ADR-012 or the batch decision. Both are assumed.
- It does not claim no abstraction will ever be needed — only that none is
  demonstrated by four callers.
