# V4-B3 — Receipt Export User-Flow Closure Reconciliation

## Status

`V4_B3_CLOSED`

Docs-only. This reconciliation closes the V4-B3 gate and opens V4-B5. It makes no
V4-complete or V5 claim, authorizes no implementation file, and changes no
runtime behaviour.

Controlling chain:

```text
7446642  authorization task-pack (PR #524)
         docs/task-packs/v4-b3-receipt-export-user-flow-authorization.md
PR #582  exact-base reconciliation
         docs/task-packs/v4-b3-receipt-export-exact-base-reconciliation.md
PR #585  module-reachability scope amendment (seventh file)
         docs/task-packs/v4-b3-module-reachability-scope-amendment.md
PR #588  implementation, exact head 5452a7680a2b3e96e5a288c928c64669cbe57cc9
         merged as main 75821f6dd4fa2f0efb0fc8669acb9c733954e5c0
```

The task-pack requires closure to be a separate reconciliation rather than a
claim made by the implementation PR alone. This is that reconciliation.

## Delivered verdict

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT
```

The gap the gate was opened for is closed. `exportMaterializedReceiptBundle()`
had a sufficient source owner and zero production callers; the bundle export is
now reachable from an authenticated Workbench route:

```text
GET /api/workbench/receipt-bundle
```

## What the closure rests on

### Scope

Seven files, exactly as authorized — six from the task-pack plus
`lib/module-reachability.js` from the PR #585 amendment:

```text
lib/http/route-auth-policy.js
lib/module-reachability.js
lib/workbench/receipt-bundle-export-route.js
lib/workbench/receipt-bundle-exporter.js
lib/workbench/workbench-read-http-router.js
package.json
test/v4-b3-receipt-bundle-export.test.js
```

`graph.js`, `kernel.js`, `server.js`, `storage.js`, `lib/receipt/*` and
`plugins/*` are unchanged. No dependency was added. The `package.json` change is
the two `files` allowlist entries and nothing else.

### The five product decisions, as built

1. **Surface.** One authenticated, read-only Workbench HTTP route. No CLI, MCP or
   UI surface was added; the acceptance test asserts their absence by scanning
   `cli.js`, `mcpServer.js` and `public/index.html`.
2. **Workspace.** Canonical `default` only, bound before any read. Exact string
   match with no trimming or coercion: padded, differently cased, blank, numeric,
   boolean, `null`, array, object and path-traversal forms all fail closed with
   `400`. The "before any read" property is proved with a source whose accessor
   throws if touched.
3. **Verification.** `verifyExportedBundle()` runs inside the bounded seam before
   any bundle is returned, and the owner independently refuses to emit a bundle
   whose verification did not report valid. Failure returns `409` with no body.
4. **Redaction: none.** The exported bundle is byte-identical to the unredacted
   source bundle, asserted by deep-equality against a direct seam export at a
   fixed `exportedAt`. Public-safe and redacted formats remain V5-C4 (#276).
5. **Bounded response.** `MAX_RECEIPTS = 1024` and
   `MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024`, enforced during the read.
   Exceeding either returns `413` with no partial bundle; exactly 1024 still
   exports. Byte accounting uses actual serialized UTF-8 bytes.

The sixth constraint from issue #271 holds: `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` are present on `200`, `400`, `409` and `413`.

### How the earlier blocked verdict was cleared

V4-B3 previously emitted `V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP` because
both ceilings could not be enforced without unbounded materialization inside the
authorized scope. That was not worked around; the prerequisite was built and
merged first.

`V4-B3A` (issue #554, PR #562, verdict
`V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_SUFFICIENT`) supplies the streaming
workspace-scoped audit read, the persisted-`details` byte guard before parse, the
short-circuiting exact UTF-8 measurement, and the bounded export that verifies
before returning. B3 consumes that seam by `require()`; it did not add a limit
parameter to the shared read index, approximate bytes from receipt count, or
enforce a ceiling after materialization.

### Evidence at exact head `5452a768`

Local:

| Command | Result |
| --- | --- |
| `node --test test/v4-b3-receipt-bundle-export.test.js` | 36 pass / 0 fail |
| `node --test test/route-auth-policy.test.js` | 11 pass / 0 fail |
| `node --test test/v4-receipt-materialization-read-index.test.js` | 8 pass / 0 fail |
| `node --test test/module-reachability.test.js` | 13 pass / 0 fail |
| `node --test test/v4-b3a-bounded-receipt-export-source.test.js` | 20 pass / 0 fail |
| `npm test` | 3267 tests — 3236 pass / 1 fail / 30 skipped |
| `npm pack --dry-run --json --ignore-scripts` | 196 files; both new modules present |
| `git diff --check` | exit 0 |

CI at the same head:

| Check | Run / job | Conclusion |
| --- | --- | --- |
| Security Checks | `31285073352` / `93172310744` | SUCCESS |
| Require graph is acyclic | `31285073314` / `93172310651` | SUCCESS |
| Classify changes | `31285073318` / `93172310649` | SUCCESS |
| Docker build | `93172327975` | SUCCESS |
| Benchmark | `93172327981` | SUCCESS |
| npm test Node 22 | `93172327995` | SUCCESS |
| npm test Node 20 | `93172327986` | SUCCESS (see the timing note below) |

## Recorded reservations

Two items are recorded rather than smoothed over. Both are resolved and neither
changes the verdict; they are stated so that a later reader does not have to
rediscover them, and so the closure names what was actually outstanding at the
moment it was claimed.

### 1. The single local `npm test` failure is environmental

```text
not ok 74 - plugins/receipt-exporter.test.js
# Error: Cannot find module 'pdfkit'
```

`pdfkit@^0.19.1` is declared in `dependencies` (landed by `87146c4` for issue
#352) but was absent from the working environment's `node_modules`, so the
plugin failed to load. B3 does not use `pdfkit`, does not touch `plugins/*` —
which the task-pack's forbidden list already excludes — and the CI jobs install
dependencies. The remaining 3236 local tests pass.

### 2. Node 20 reported after the merge, not before it

The evidence itself is complete: Node 20 job `93172327986` completed SUCCESS at
`2026-08-09T00:04:29Z`, so the full-suite matrix is green on both versions at
head `5452a768`.

What is worth recording is the ordering. The merge happened at
`2026-08-08T23:58:28Z`, while that job was still `in_progress` — its `npm ci`
finished at `23:57:41` and its full-suite step had been running for 47 seconds
against a suite that takes roughly six and a half minutes on this runner. Node 22
(`93172327995`) had reported SUCCESS at `23:58:10` and Security Checks at
`23:58:15`, so the merge rested on those plus the local full run, with one matrix
leg outstanding.

It landed green, so nothing needs revisiting. But a gate that merges before its
own required evidence reports is only accidentally correct, and this repository's
whole claim is that its receipts bind. Recording the six-minute gap costs nothing
now; discovering it later from a red leg would have cost the closure.

Node 20 passing also confirms the diagnosis in reservation 1: with dependencies
installed, `plugins/receipt-exporter.test.js` passes, so the local failure was
environmental rather than a defect.

## Roadmap effect

- V4-B3 moves from the open gate to closed evidence.
- The next and only open gate is V4-B5 source/test/CI/package/release closeout
  (issue #272).
- Two checkpoint `forbiddenClaims` entries are now false and are removed:
  "V4-B3 receipt export user flow implemented, reachable or proved" and "receipt
  bundle export reachable from any production route or user flow". Both describe
  the state B3 was opened to change.
- Everything else stays forbidden. V4 Workbench completion, V5 authorization and
  V5 completion remain unclaimed, and closing B3 does not imply any of them.

## What closing B3 does not mean

- It does not close V4. V4-B5 is untouched by this work.
- It does not make the bundle public-safe. The artifact is internal and
  unredacted by design; a public format is V5-C4 (#276).
- It does not open a non-default workspace surface, pagination, or a second
  export owner. Those remain permanent ordering rules and non-goals.
