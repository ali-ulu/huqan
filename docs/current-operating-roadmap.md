# Current Operating Roadmap

**Live baseline:** `main` at
`ab9a982419e844c3ec79490c5f803c2a4890788c` (PR #256 V4-WB2 product
route-contract authorization merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The External Client Enablement-0 evidence program is closed, but its HTTP
adapter remains production-unreachable. V4 Workbench runtime-evidence work is
active. The Trust Receipt Inspector has an authenticated product route and
prior no-mock real-server evidence.

The Memory Admission / Context Integrity Inspector now has:

- a proven durable source contract;
- a merged internal read-only audit-source adapter; and
- an authorized pure product route-contract helper.

WB2 still has no registered route, product-runtime evidence or package
reachability.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247 / #248 | WB2 durable-source authorization and reconciliation | Test-only source contract |
| #249 / #250 | WB2 durable-source proof and reconciliation | Source sufficient; no adapter or route |
| #251 / #252 | WB2 adapter authorization and reconciliation | Exact internal adapter/test scope |
| #254 / #255 | WB2 adapter implementation and reconciliation | Internal read-only adapter; no route |
| #256 | WB2 pure route-contract authorization | No server or package wiring |

## Closed WB2 durable-source evidence

PR #249 changed exactly
`test/v4-wb2-memory-context-runtime-source.test.js` at reviewed head
`59942569d327249d9319e9228f79be17feeb80ae`.

Evidence:

- Security Checks run `31022647956`: `SUCCESS`
- Benchmark Regression run `31022647907`: `SUCCESS`
- full `npm test` job `92363082880`: `SUCCESS`

It used real `Kernel`, SQLite-backed `Graph`, real learn admission and
close/reopen evidence to prove exact workspace isolation, unknown-ID
fail-closed behavior, source-backed canonical mutation and read-only
inspection.

Verdict:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

## Closed WB2 audit-source adapter

PR #254 changed exactly:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

Reviewed head `d662f6e545e5be12d5f7937d45599f1f6c33c989` passed:

- Security Checks run `31025724234`;
- Benchmark Regression run `31025724138`; and
- full `npm test` job `92373576698`.

PR #254 merged as `cab8f49b4111b73605bebc86124446cb6d283939`.
PR #255 reconciled it as live main
`d0b789e2e74049c09a1ae2ede063ed2a271d2b22`.

The adapter requires exact `auditId` plus workspace, enforces a maximum
`1024`-record scan, fails closed on malformed, duplicate and over-bound reads,
maps only source-backed fields, leaves `traceId` null and exposes no mutation,
approval or action method.

## Closed product route-contract authorization

PR #256 added exactly:

```text
docs/task-packs/v4-wb2-product-route-contract-authorization.md
```

Exact reviewed head:

```text
f515a46969d044f0d12e4f99fbada3f3f8b1f6c6
```

Exact-head evidence:

- Security Checks run `31027170656`: `SUCCESS`
- Benchmark Regression run `31027174685`: `SUCCESS`
- exact one-file docs scope
- one commit ahead, zero behind, exact merge base
- zero open review threads

PR #256 merged as live main
`ab9a982419e844c3ec79490c5f803c2a4890788c`.

The authorization reserves:

```text
GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId
```

It requires exact non-empty audit ID and explicit workspace authority, rejects
malformed, oversized and extra path identity, and preserves this chain:

```text
createMemoryContextAuditSource
-> inspectMemoryContext
-> bounded HTTP status mapping
```

It does not authorize `server.js`, request guards, package allowlist or real
server smoke.

## Current gate

This reconciliation opens only:

```text
V4_WB2C_PRODUCT_ROUTE_CONTRACT_IMPLEMENTATION
```

The implementation candidate must start from exact canonical main
`ab9a982419e844c3ec79490c5f803c2a4890788c` and add exactly:

```text
lib/workbench/memory-context-route.js
test/v4-wb2c-memory-context-route-contract.test.js
```

No existing file may change.

The helper must export exactly:

```text
ROUTE_PREFIX
parseWorkbenchMemoryContextPath
handleWorkbenchMemoryContextRequest
```

It must require exact audit/workspace identity, reject rather than truncate
oversized identity, expose only `GET` contract semantics, delegate through the
existing adapter and inspector, and map:

```text
ok              -> 200
invalid_request -> 400
not_found       -> 404
read_error      -> 502
unknown         -> 502
```

The implementation is pure and not server-reachable. Package dry-run must stay
unchanged. After merge, only reconciliation may open
`V4_WB2D_SERVER_WIRING_AUTHORIZATION`.

## Later server-wiring gate

A separate authorization must cover:

- exact `server.js` insertion point and existing outer guard order;
- `GET` only and API-key rejection before adapter invocation;
- mandatory `workspaceId` query authority;
- `Cache-Control: no-store` on all WB2 responses;
- CORS, content type and `nosniff` behavior;
- real Kernel plus SQLite Graph no-mock server smoke;
- malformed, oversized, unknown, cross-workspace and read-error paths;
- before/after graph and audit snapshots;
- WB3 and legacy receipt-route regressions;
- npm package allowlist for both WB2 runtime modules; and
- installed-tarball server smoke.

## Remaining execution order

1. Implement, review, merge and reconcile the pure WB2 route contract.
2. Separately authorize and implement authenticated server wiring plus package
   and no-mock smoke evidence.
3. Complete remaining V4 action/approval, receipt-export user-flow and closeout
   gates.
4. Begin V5 successors only after V4 closeout and external interoperability.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- No production route registration without separate authorization.
- Identity and workspace authority remain pre-bound and explicit.
- Missing context or provenance is never reconstructed.
- `provenanceId` and `sourceRef` are not trace identifiers.
- Internal helper existence is not product-runtime evidence.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No external-client production route.
- No WB2 server, MCP, CLI, UI or package wiring in the pure contract gate.
- No new persistence, schema, table, index, migration or dependency.
- No default workspace or alternate audit identity.
- No full receipt or arbitrary audit-details exposure.
- No version, release or deployment change.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
