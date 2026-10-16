# V4-WB2 Audit-Source Adapter Authorization

## Authorization identity

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ 688af1d36599759746bf8cb6e2a4b9f010482466`
- Package version: `0.9.1`
- Active roadmap gate: `V4_WB2B_AUDIT_SOURCE_ADAPTER_AUTHORIZATION`
- Authorized successor: `V4_WB2B_AUDIT_SOURCE_ADAPTER_IMPLEMENTATION`
- This document authorizes one narrow read-only adapter below the product route
  layer. It does not authorize route or server wiring.

## Source-backed decision

PR #249 proved that current durable audit records are sufficient to feed the
existing Memory Context Inspector without a new store, schema or migration.
The implementation must now move only the already-proven selection and mapping
responsibility out of test code and into one single-purpose adapter.

The adapter must not normalize the final Workbench response itself.
`inspectMemoryContext()` remains the sole output normalizer.

## Directly observed current owners

### Graph audit owner

`Graph.appendAuditEvent()` persists normalized audit records to the in-memory
mirror and SQLite audit table. `Graph.getAuditEvents(filters)` returns cloned,
workspace-filterable audit records and merges SQLite plus in-memory state by
exact `auditId`.

The current Graph API does not expose a direct `auditId` query. The adapter may
use only the existing `getAuditEvents({ workspaceId })` read boundary and must
apply an explicit scan limit before selecting one exact identifier.

### Inspector owner

`lib/workbench/memory-context-inspector.js` already owns request validation,
source invocation, record lookup normalization and the bounded result envelope:

- `invalid_request`
- `not_found`
- `read_error`
- `ok`

The adapter may supply a source implementing `readMemoryContext(query)`. It may
not duplicate or replace inspector result normalization.

### Proven durable mapping

`test/v4-wb2-memory-context-runtime-source.test.js` proved these source facts:

- review and approved admission records survive SQLite close/reopen;
- exact workspace selection prevents cross-workspace lookup;
- unknown identifiers fail closed;
- canonical mutation is asserted only for an actual `LEARN` or `REAFFIRMED`
  edge audit carrying an existing canonical allow receipt; and
- lookup plus inspection do not mutate graph or audit state.

The current inspector output exposes `traceId`, `workspaceId` and `receiptId` as
its provenance surface. The audit record does not contain a source-backed
`traceId`. The adapter must therefore leave `traceId` absent/null rather than
relabel `provenanceId` or `sourceRef` as a trace identifier.

## Exact implementation scope

The successor may add exactly:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

No existing production file may change.

The production module should remain under 200 lines. The test owner should
remain under 300 lines where practical without weakening real SQLite evidence.

## Required adapter contract

The production module must export exactly:

```text
createMemoryContextAuditSource
```

The factory accepts a Graph-compatible read owner and optional bounded settings,
then returns an object exposing exactly:

```text
readMemoryContext({ recordId, workspaceId })
```

### Input authority

- `recordId` must be a non-empty exact audit identifier.
- `workspaceId` must be a non-empty exact workspace identifier.
- No fallback to `default`, another workspace, target text, receipt ID,
  provenance ID, array position or latest record is allowed.
- Caller-provided admission, receipt, mutation or provenance fields are not
  accepted.

### Read boundary

- The supplied owner must expose `getAuditEvents(filters)`.
- The adapter calls it with only the exact workspace filter.
- Returned data must be an array.
- A fixed conservative scan cap must be enforced. The default cap must be no
  greater than `1024` records.
- Exceeding the cap, malformed returned data or duplicate exact `auditId`
  matches must fail closed by throwing a stable adapter error. The existing
  inspector converts that failure to `read_error`.
- Zero exact matches return `null`, allowing the inspector to return
  `not_found`.

### Source-backed mapping

For one exact record, map only fields already present in the audit event or its
existing admission receipt:

- `recordId` from `event.auditId`;
- `workspaceId` from `event.workspaceId`;
- decision from `details.admissionOutcome`, otherwise existing receipt
  `decision`;
- status derived only from that decision;
- reason from `details.reason`, otherwise existing receipt `reason`;
- receipt ID from `details.receiptId`, otherwise existing receipt `receiptId`;
- workspace integrity from the exact workspace match;
- canonical mutation only when all are true:
  - decision is `allow`;
  - receipt has `canonical === true`;
  - target type is `edge`; and
  - event type is `LEARN` or `REAFFIRMED`;
- mutation allowed only when canonical mutation is source-backed and decision
  is `allow`.

The mapped record must place `contextIntegrity` under `memoryAdmission`, matching
the current inspector contract.

Do not expose or copy the full receipt, arbitrary `details`, target text,
private source data, `provenanceId` or `sourceRef` into the mapped inspector
record. Do not synthesize `traceId`.

## Required fail-closed tests

The exact test owner must use real current runtime owners where applicable and
cover at least:

1. Factory rejects a missing or malformed Graph-compatible owner.
2. Missing or blank exact workspace returns no record.
3. Missing or blank exact audit ID returns no record.
4. One real review admission maps to `review_required` after SQLite reopen.
5. One real approved admission maps to `admitted` and canonical mutation only
   from the durable edge audit plus canonical allow receipt.
6. Unknown audit ID returns `not_found` through `inspectMemoryContext()`.
7. Cross-workspace lookup returns `not_found`.
8. Duplicate exact audit IDs in supplied source data fail as `read_error`.
9. Scan-cap overflow fails as `read_error` before selection.
10. Malformed Graph return values fail as `read_error`.
11. `provenanceId` and `sourceRef` are not relabeled as `traceId`.
12. Missing receipt/provenance links remain null rather than fabricated.
13. Adapter read plus inspector normalization leaves nodes, edges and audit rows
    unchanged.
14. The source object exposes no mutation, approval or action method.

Tests may use a minimal fake read owner only for malformed-return, duplicate and
scan-cap branches that cannot be produced through the canonical Graph owner.
Positive persistence, workspace, review and approved paths must use real
`Kernel`, real SQLite-backed `Graph` and real learn admission.

## Acceptance commands

```bash
node --test test/v4-wb2-memory-context-audit-source.test.js
node --test test/v4-wb2-memory-context-runtime-source.test.js
node --test test/v4-wb2-memory-context-inspector.test.js
node --test test/v4-memory-admission-context-integrity-surface.test.js
npm test
npm pack --dry-run --json --ignore-scripts
graphify update .
git diff --check
git diff --name-only <exact-base>...HEAD
git status --short
```

Acceptance requires:

- exact two-file implementation scope;
- targeted tests and full regression exit `0` with zero failures;
- real SQLite close/reopen evidence;
- package dry-run remains unchanged and does not publish the new internal
  adapter;
- Graphify produces no unexplained unrelated drift;
- exact-head Security Checks and Benchmark Regression succeed;
- zero unresolved review threads; and
- no mutation caused by adapter reads.

## Successor sequence

After implementation evidence passes and merges:

```text
V4_WB2B_AUDIT_SOURCE_ADAPTER_IMPLEMENTATION
-> V4_WB2B_AUDIT_SOURCE_ADAPTER_RECONCILIATION
-> V4_WB2C_PRODUCT_ROUTE_CONTRACT_AUTHORIZATION
```

The route-contract authorization must separately decide authenticated identity,
workspace authority, request bounds, status mapping and product reachability.
No route may be added during this adapter gate.

## Forbidden scope

- no change to `graph.js`, `kernel.js`, `server.js`, `mcpServer.js`, `cli.js`
  or `lib/memory-store.js`;
- no change to the existing inspector, learn path, audit writer or receipt
  semantics;
- no database table, query, index, migration, schema or dependency;
- no route, server, MCP, CLI, UI or public API wiring;
- no package `files` expansion, version or release change;
- no caller-controlled authority or cross-workspace fallback;
- no full receipt/details export;
- no automatic retry, repair, mutation or approval transition;
- no V4-complete, production-ready or V5-complete claim.

## Stop conditions

Stop without widening scope if:

- exact selection cannot remain workspace-bound;
- adapter behavior requires a new Graph query or persistence primitive;
- the existing inspector contract must change;
- provenance would require relabeling `provenanceId` as `traceId`;
- package publication is required for the adapter gate;
- exact implementation scope cannot remain two files; or
- any positive path requires a fake runtime owner.

## Connector-only limits

During this docs-only authorization, local clone bootstrap,
`node scripts/agent-context.js`, local worktree state, local test commands,
`git diff --check` and Graphify refresh were unavailable through the connector
environment. Exact live source, Git ancestry, changed-file scope and GitHub CI
remain controlling evidence.

## Non-claims

This authorization does not claim that:

- the adapter is implemented;
- WB2 is product-runtime reachable;
- an authenticated route exists;
- full provenance details are exposed by the inspector;
- a new persistence model is authorized;
- Workbench is complete; or
- V5 implementation has started.
