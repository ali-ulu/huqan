# V4-B3 — Receipt Export User-Flow Authorization

## Status

`AUTHORIZED_FOR_EXACT_BASE_IMPLEMENTATION`

This task-pack authorizes one bounded receipt-bundle export user flow. It does
not claim that V4-B3 is closed, and it does not open V4-B5 or V5.

## Exact Base

```text
repository: ali-ulu/huqan
base branch: main
authorization artifact: 7446642 (docs: authorize the V4-B3 receipt export user flow)
authorization merge:    PR #524 / 617040f6d95faf11eaaab736c507c3b11e0be9df
V4-B2 closure merge:    PR #523 / 9b6d41f801a918451e3e5142498204d86a549f59
V4-B2 implementation:   PR #520 / e02eb03e79e10d6bc65e02322febe5eb2fd15055
```

### Base rule: authorization artifact ancestry, not a pinned main

Earlier task-packs pinned a pre-merge `main` SHA as the implementation base.
That rule stales itself by construction: merging the authorization PR advances
`main` past the pin, so the pin is already wrong the moment it becomes
effective, and every subsequent merge demands another reconciliation. V4-B3 hit
this twice — once when PR #524 merged during its own review, and again while
this refresh was in review.

This task-pack therefore binds an **immutable authorization artifact** instead:

1. The controlling artifact is commit `7446642`, which introduced this
   task-pack. It is immutable and never advances.
2. The implementation branch is opened from **live `origin/main` at the moment
   work starts**, not from a recorded SHA.
3. `7446642` must be an ancestor of that branch. If it is not, the branch is not
   authorized.
4. The successor then diffs the authorization artifact against its live base
   over the six authorized implementation files:

   ```bash
   git merge-base --is-ancestor 7446642 HEAD
   git diff --name-only 7446642..HEAD -- \
     lib/workbench/receipt-bundle-exporter.js \
     lib/workbench/receipt-bundle-export-route.js \
     lib/workbench/workbench-read-http-router.js \
     lib/http/route-auth-policy.js \
     package.json \
     test/v4-b3-receipt-bundle-export.test.js
   ```

   - **Empty output** — the contract is source-compatible. Record that proof in
     the implementation PR and begin work. No reconciliation PR is required, and
     unrelated merges to `main` never block implementation again.
   - **Non-empty output** — a reconciliation is mandatory before code, because
     an authorized file moved underneath the contract.

5. Live source, exact Git SHA, tests and CI still outrank this document. The
   change is only to which SHA is treated as controlling: the immutable artifact
   rather than a mutable branch tip.

Source-compatibility proof at the time of this refresh: between `7446642` and
live `main` `d70c0a0`, the intervening work is PR #524 (this task-pack), PR #511
non-root Dockerfile runtime and its test, PR #521 `kernel.d.ts` audit-seam
typing, and PR #512 removing the dead GitHub Pages workflow. None touches any of
the six authorized implementation files. The contract, the five product
decisions, the ceilings and the status mapping are unchanged.

## Source-Reality Verdict

`exportMaterializedReceiptBundle()` (`lib/receipt/receipt-read-index.js:212`)
already builds a materialized receipt chain and returns a bundle that
`verifyExportedBundle()` (`lib/receipt/receipt-export.js:62`) validates. Its only
caller in the tree is `test/v4-receipt-materialization-read-index.test.js`.
Production callers number zero.

The user-reachable receipt surface today is read-only:

- `GET /api/trust-receipt` and `GET /api/trust-receipt/:receiptId`;
- `GET /api/workbench/trust-receipt/:receiptId` (V4-B1, closed);
- `plugins/receipt-exporter.js`, which writes single receipts to files on
  `afterLearn` rather than emitting a chain-validated bundle.

This is the shape V4-B1 already resolved for WB2: a sufficient source owner with
no route. V4-B3 is therefore a reachability gap plus bounded product decisions,
not a missing primitive.

## Product Decisions

These five decisions are settled. This task-pack records them; it does not
reopen them.

### 1. Surface

One authenticated, read-only Workbench HTTP route:

```text
GET /api/workbench/receipt-bundle
```

No CLI, MCP or UI surface. B3 is the Workbench real-user flow.

### 2. Workspace authority

Canonical `default` only. Omitted means `default`; a supplied value must be the
exact string `default`; every other value fails closed before any read. Values
are not trimmed or coerced first, matching the boundary PR #301 repaired for the
WB2 audit source and PR #520 applied to ingest snapshots.

This follows the permanent ordering rule: no non-default or caller-selected HTTP
workspace authority.

### 3. Verification

`verifyExportedBundle()` runs after `exportMaterializedReceiptBundle()` and
before any response body is written. If verification fails, no bundle is
returned — not a partial bundle, not an unverified bundle, not the bundle with a
warning flag.

### 4. Redaction: none

The exported bundle stays an internal, full trust artifact. No field is stripped,
masked or reshaped.

This boundary is load-bearing rather than stylistic. Canonical receipt content
including `metadata` participates in the hash semantics that
`verifyExportedBundle()` checks, so removing fields during a B3 export would
either break chain validation or amount to defining a new public receipt format.
Public-safe and redacted receipt formats are V5-C4 work (issue #276).

### 5. Bounded response

Both ceilings are mandatory:

```text
MAX_RECEIPTS = 1024
MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024
```

Exceeding either fails closed with HTTP `413`. A partial, truncated or paginated
bundle is never returned.

Byte accounting uses the actual serialized UTF-8 bytes of the bundle that would
be sent, not an estimate derived from receipt count.

**Justification.** These numbers come from repository precedent plus
measurement, not from the roadmap — the roadmap mandates that ceilings exist,
not what they are.

- `MAX_RECEIPTS = 1024` matches `MAX_AUDIT_EVENTS_LIMIT`
  (`lib/workbench/memory-context-audit-source.js:4`), the sibling Workbench read
  owner, which uses 1024 as both its default and its hard limit. Both Workbench
  read surfaces therefore share one record bound.
- `MAX_SERIALIZED_BUNDLE_BYTES = 2 MiB` matches `MAX_EXTERNAL_SNAPSHOT_BYTES`
  (`lib/ingest.js:6`), the existing bound for a hash-sealed bounded artifact.
- Measured on the real `kernel.learn()` admission path, canonical v4 receipts
  serialize at a steady ~725 bytes each (894 bytes for a single-receipt bundle,
  where the envelope is a fixed cost; 7 375 / 36 295 / 72 446 / 181 346 bytes at
  10 / 50 / 100 / 250 receipts, every bundle verifying).

At ~725 bytes, 1024 receipts is roughly 725 KiB — about a third of the byte
ceiling. The count ceiling therefore binds in normal operation, and the byte
ceiling acts as an independent secondary guard that only engages on anomalies
such as unusually large receipt metadata (above roughly 2 KiB average). A 1 MiB
byte ceiling was rejected because it would start binding at around 1 KiB average
receipt size, making the safety net interfere with normal operation.

### 6. Response headers

`Cache-Control: no-store` and `X-Content-Type-Options: nosniff` are preserved on
every response, success or failure, reusing the existing header constant in
`lib/workbench/workbench-read-http-router.js`.

## Status Mapping

```text
200  verified bundle within both ceilings
400  invalid request, including any non-default workspace value
409  chain invalid, or bundle verification failed after export
413  receipt count or serialized byte ceiling exceeded
502  read error from the underlying source
```

`404` is not used for an empty result: an authenticated caller with zero
receipts receives `200` with an empty, verified bundle, because absence of
receipts is a truthful state rather than a missing resource.

No raw exception, stack, private Graph row or unbounded internal value appears in
any response.

## Thin-Orchestrator Design

`server.js` is **not** in scope. The Workbench read router is already wired at
`server.js:17`, and `lib/workbench/trust-receipt-inspector.js:3` establishes that
a Workbench owner may require `lib/receipt/receipt-read-index` directly rather
than receiving it as an injected dependency. The new owner follows that
precedent.

New domain logic belongs in two bounded modules, matching the existing
inspector/route split:

```text
lib/workbench/receipt-bundle-exporter.js      bounded owner
lib/workbench/receipt-bundle-export-route.js  pure route contract
```

Each module remains at or below 200 physical lines. They may reuse existing
receipt, chain, export and header primitives; they must not duplicate a receipt
schema, define a new receipt format or create a second export owner.

## Authorized Implementation Files

The successor may change exactly:

```text
lib/workbench/receipt-bundle-exporter.js
lib/workbench/receipt-bundle-export-route.js
lib/workbench/workbench-read-http-router.js
lib/http/route-auth-policy.js
package.json
test/v4-b3-receipt-bundle-export.test.js
```

File purposes:

- `receipt-bundle-exporter.js`: canonical workspace resolution, the single
  `exportMaterializedReceiptBundle()` call, mandatory `verifyExportedBundle()`,
  both ceilings, and bounded outcome mapping.
- `receipt-bundle-export-route.js`: path/method parsing and status mapping only.
- `workbench-read-http-router.js`: register the new route beside the existing
  two, reusing the existing no-store/nosniff header constant.
- `route-auth-policy.js`: declare the route so an undeclared path stays a `404`
  instead of leaking its existence through a `401`.
- `package.json`: add only the two new runtime modules to the existing `files`
  allowlist; no other metadata change.
- `test/v4-b3-receipt-bundle-export.test.js`: real server, Kernel, SQLite Graph
  and loopback HTTP acceptance and adversarial evidence.

No seventh file is authorized. Any further owner is a stop condition and
requires another source-backed scope amendment. If a conflicting assertion is
found in an unlisted file, record the amendment explicitly rather than editing
it silently — PR #520 set that precedent with `server.test.js`.

## Required Acceptance Evidence

The exact-head test must prove:

1. an authenticated request with omitted and with exact `default` workspace both
   return `200` with a bundle that `verifyExportedBundle()` accepts;
2. an unauthenticated request is denied, and an undeclared neighbouring path
   returns `404` rather than `401`;
3. every non-default workspace value — including padded, differently cased,
   blank, numeric, boolean, array and object forms — fails closed with `400`
   before any read;
4. a caller with zero receipts receives `200` and an empty verified bundle, not
   `404`;
5. a tampered or broken chain returns `409` and no bundle body;
6. a bundle that fails `verifyExportedBundle()` returns `409` and no bundle body,
   proved by forcing verification failure rather than by asserting the happy
   path;
7. exceeding `MAX_RECEIPTS` returns `413` with no partial bundle;
8. exceeding `MAX_SERIALIZED_BUNDLE_BYTES` returns `413` with no partial bundle,
   with the byte count taken from the actual serialized UTF-8 payload;
9. `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` are present on
   success, on `400`, on `409` and on `413`;
10. the response contains no raw exception, stack or private Graph row;
11. the exported bundle is byte-identical to the unredacted source bundle — no
    field is stripped, masked or reshaped;
12. the route is declared in `lib/http/route-auth-policy.js`;
13. no CLI, MCP or UI surface is added;
14. package dry-run contains both new modules and does not expand unrelated
    public/runtime files;
15. targeted tests and full `npm test` pass on the exact head.

The implementation candidate must finish with exactly one verdict:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT
V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP
```

A blocked verdict is acceptable evidence. It must not be hidden by weakening an
assertion, relaxing a ceiling, or returning an unverified or partial bundle.

## Forbidden

- No redaction, masking, field stripping or public-safe reshaping.
- No new receipt format, schema, or second export owner.
- No caller-selected non-default workspace.
- No pagination, truncation or partial-bundle response.
- No unverified bundle leaving the process under any status code.
- No CLI, MCP, UI, external-client route, release or deployment change.
- No new dependency.
- No change to `graph.js`, `kernel.js`, `storage.js`, `server.js`,
  `lib/receipt/*` or plugins.
- No raw exception or result leakage.
- No V4-B3, V4-B5, V4-complete or V5-complete claim from the implementation PR
  alone; closure requires a separate reconciliation.

## Stop Conditions

Stop without runtime implementation if:

- canonical `default` cannot be bound before the first read;
- `verifyExportedBundle()` cannot run before the response is written;
- either ceiling cannot be enforced without returning a partial bundle;
- enforcing the byte ceiling would require serializing more than
  `MAX_SERIALIZED_BUNDLE_BYTES` into memory in an unbounded way.

  This is a named falsification target, not a hypothetical.
  `collectMaterializedReceiptEntries()`
  (`lib/receipt/receipt-read-index.js:80`) calls `getAuditEvents()` with no
  limit and `clone()`s every matching receipt into memory;
  `buildMaterializedReceiptChain()` then builds the whole chain before
  `exportReceiptBundle()` serializes it. By the time actual serialized UTF-8
  bytes can be measured, the full set has already been materialized.

  The successor must establish whether both ceilings can be enforced within the
  authorized files without that unbounded materialization. If they cannot, the
  correct outcome is the `BLOCKED_GAP` verdict. It is **not** correct to widen
  scope into `lib/receipt/*`, to add a limit parameter to the shared read index,
  to approximate the byte ceiling from receipt count, or to enforce the ceiling
  only after materialization while calling it bounded;
- the route cannot be declared in the central auth policy;
- an unlisted file must change;
- the authorization artifact `7446642` is not an ancestor of the working base,
  or the six-file source-compatibility diff against it is non-empty.

## Validation Commands

```bash
node scripts/agent-context.js
node --test test/v4-b3-receipt-bundle-export.test.js
node --test test/v4-receipt-materialization-read-index.test.js
node --test test/route-auth-policy.test.js
npm test
npm pack --dry-run --json --ignore-scripts
git diff --check
git status --short
```

Connector-only work must record local bootstrap, worktree, package dry-run and
Graphify as unverified rather than inventing evidence.
