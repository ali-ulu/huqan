# V4-B3 — Exact-Base Reconciliation and Blocked-Gap Clearance

## Status

`RECONCILED_FOR_IMPLEMENTATION`

This document is docs-only. It reconciles observed `package.json` drift for the
V4-B3 receipt export contract and records that the prerequisite which produced
`V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP` has closed. It authorizes no new
file, changes no product decision, and does not claim V4-B3, V4-B5 or V4 closure.

Controlling document:
`docs/task-packs/v4-b3-receipt-export-user-flow-authorization.md`
(authorization artifact `7446642`, merged by PR #524).

## Why this reconciliation exists

The controlling task-pack ends its `8b3227f` record with a binding scope note:

> re-run the six-file diff from the live base when work starts, and re-prove the
> shape by parsing both revisions every time rather than trusting either
> recorded verdict. […] Any path other than `package.json` in the diff output,
> any removal or range change in either key, or a change to any other top-level
> `package.json` key remains an unreconciled stop condition.

That note was exercised as written. At live `main` the drift is no longer the
shape either prior record reconciled, so implementation stopped a third time and
this reconciliation was written before any code.

## Observed base

```text
repository:            ali-ulu/huqan
authorization artifact: 7446642
live main:             d55ce06 (PR #580 merge)
```

Ancestry holds:

```bash
$ git merge-base --is-ancestor 7446642 HEAD && echo ok
ok
```

Six-file source-compatibility diff:

```bash
$ git diff --name-only 7446642..d55ce06 -- \
    lib/workbench/receipt-bundle-exporter.js \
    lib/workbench/receipt-bundle-export-route.js \
    lib/workbench/workbench-read-http-router.js \
    lib/http/route-auth-policy.js \
    package.json \
    test/v4-b3-receipt-bundle-export.test.js
package.json
```

Exactly one path, as before. The two owner modules and the acceptance test do not
exist yet, and both files B3 edits in place —
`lib/workbench/workbench-read-http-router.js` and
`lib/http/route-auth-policy.js` — are byte-identical between `7446642` and the
live base. The route registration and auth-policy declaration therefore apply
verbatim.

## Drift shape, proved by parsing both revisions

Parsing `7446642:package.json` against `d55ce06:package.json` rather than reading
the diff hunk:

```text
differing top-level keys: [ 'scripts', 'files', 'dependencies' ]

scripts:      +0  -0   range-changed=1
  train: "node egitim.js" -> "node scripts/egitim-demo.js --demo"

files:        +11 -1   retained-order-preserved=true
  added:   lib/audit-bounded-read.js
           lib/command-parser.js
           lib/json-utf8-size.js
           lib/kernel-factory.js
           lib/receipt/bounded-receipt-export.js
           lib/self-healer/dryrun-runner.js
           lib/self-healer/finding-schema.js
           lib/self-healer/safety-decision.js
           lib/self-healer/source-dependency-graph.js
           lib/self-healer/source-dogfood-simulator.js
           scripts/egitim-demo.js
  removed: egitim.js

dependencies: +1  -0   range-changed=0
  added:   pdfkit@^0.19.1
```

Two of these are new relative to the recorded verdicts, and both are named stop
conditions in the scope note: a **removal** inside `files`, and a change to a
**third top-level key**, `scripts`.

### Provenance of the new drift

The `files` removal and the `scripts.train` change are the same work. Commit
`b12fe47`, `fix(security): isolate and harden the egitim demo script (#363)`,
moved the training demo out of the published surface: `egitim.js` left the `files`
allowlist, `scripts/egitim-demo.js` entered it, and `scripts.train` was repointed
at the relocated script with an explicit `--demo` flag. `egitim.js` still exists
in the repository; only its published and script-entry status changed.

`lib/audit-bounded-read.js`, `lib/json-utf8-size.js` and
`lib/receipt/bounded-receipt-export.js` are the V4-B3A bounded seam modules
landed by PR #562. The remaining additions are the previously reconciled
`lib/command-parser.js`, `lib/kernel-factory.js` and `lib/self-healer/*` entries.
`pdfkit@^0.19.1` is the already-reconciled `8b3227f` drift from issue #352.

### Verdict: source-compatible

The authorized B3 `package.json` change is an insertion of exactly two paths —
`lib/workbench/receipt-bundle-exporter.js` and
`lib/workbench/receipt-bundle-export-route.js` — into the sorted `files`
allowlist. Neither appears in `files` at either revision, confirmed by parsing:

```text
B3 target modules present in files at live base? false false
```

Each drift is disjoint from that insertion:

- **`files` removal of `egitim.js`.** A removal cannot collide with an insertion
  of two different paths. The retained entries keep their relative order, so the
  sorted-list invariant the B3 edit relies on is intact. The removed path is not
  a B3 path and no B3 file reads the allowlist at runtime.
- **`scripts.train`.** `scripts` is a top-level key B3 neither edits nor reads.
  The authorized `package.json` change is explicitly "the two `files` entries and
  nothing else", so a `scripts` value change cannot conflict with it.
- **`dependencies` gaining `pdfkit`.** Unchanged from the `8b3227f` record: the
  keys are disjoint, and the package is consumed only by
  `plugins/receipt-exporter.js`, which the forbidden list already excludes.

This does not relax B3's own "no new dependency" prohibition. The B3
implementation still adds no dependency, and its `package.json` change remains
the two `files` entries and nothing else.

### Scope note for the successor, superseding the prior one

Re-run the six-file diff from the live base when work starts and re-prove the
shape by parsing both revisions rather than trusting any recorded verdict.
Additive and removal drift inside `files`, additive drift inside `dependencies`,
and value changes inside `scripts` are now reconciled as source-compatible. Any
path other than `package.json` in the diff output, any range change or removal in
`dependencies`, any reordering of retained `files` entries, or a change to a
top-level `package.json` key other than `files`, `dependencies` and `scripts`
remains an unreconciled stop condition.

## Blocked-gap clearance

The controlling task-pack carries a blocking note above its Source-Reality
Verdict: the six-file route contract must not be implemented directly over an
unbounded `getAuditEvents()` read, and the V4-B3A bounded source seam is a
prerequisite. The recorded parent verdict was
`V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP`.

That prerequisite has closed. Issue #554 emitted
`V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_SUFFICIENT`, and PR #562 merged at exact head
`8b86b3701ec6794167df7f14e1ce6f240e606d02`.

The merged seam answers the named falsification target directly:

- `lib/audit-bounded-read.js` streams workspace-scoped audit events one row at a
  time and applies a persisted-`details` byte guard before any full fetch or
  parse, replacing the unbounded `.all()` path;
- `lib/json-utf8-size.js` measures exact JSON UTF-8 bytes with a short-circuit,
  so an over-limit value is never fully serialized in order to be measured;
- `lib/receipt/bounded-receipt-export.js::exportMaterializedReceiptBundleBounded()`
  accepts only the canonical `default` workspace, stops at receipt 1025, guards
  the accumulating chain against the byte ceiling during construction, and runs
  `verifyExportedBundle()` before returning any bundle. Its exported constants
  are `MAX_RECEIPTS = 1024` and `MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024`,
  matching the ceilings this task-pack fixed.

Both ceilings are therefore enforceable without unbounded materialization, and
without approximating bytes from receipt count. The stop condition that produced
the blocked verdict no longer holds.

## What this reconciliation does not change

- The five product decisions, both ceilings and the status mapping stand exactly
  as written in the controlling task-pack.
- The authorized six-file scope is unchanged. No seventh implementation file is
  granted. The B3A modules are consumed by `require()` from an authorized owner;
  consuming a module is not changing it, and `lib/receipt/*` remains on the
  forbidden-to-modify list.
- Redaction remains out of scope. The bundle stays an internal, full trust
  artifact; public-safe and redacted formats remain V5-C4 (#276).
- The `BLOCKED_GAP` outcome remains available. If the successor finds that the
  bounded seam cannot in fact satisfy both ceilings inside the authorized files,
  the correct outcome is still the blocked verdict, not a widened scope or a
  relaxed ceiling.

## Successor entry conditions

1. Open the implementation branch from live `origin/main`.
2. Re-verify `7446642` ancestry and re-run the six-file diff, re-proving the
   `package.json` shape by parsing both revisions.
3. Implement within the authorized six files only.
4. Emit exactly one of `V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT` or
   `V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP`, with the acceptance evidence the
   controlling task-pack enumerates.
