# Current Operating Roadmap

**Live baseline:** `main` at
`eed1d90a6c0f5b707ed25ff822265eb9b2038e43` (PR #258 V4-WB2 pure product
route-contract implementation merge).

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
- a merged pure product route-contract helper.

WB2 still has no registered server route, no-mock product-runtime evidence or
npm package reachability.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256 / #257 | WB2 pure route-contract authorization and reconciliation | No server or package wiring |
| #258 | WB2 pure route-contract implementation | Helper merged; route still unreachable |

## Closed WB2 durable-source evidence

PR #249 changed exactly
`test/v4-wb2-memory-context-runtime-source.test.js` at reviewed head
`59942569d327249d9319e9228f79be17feeb80ae`.

It passed Security Checks run `31022647956`, Benchmark Regression run
`31022647907` and full `npm test` job `92363082880`. Real `Kernel`,
SQLite-backed `Graph`, real learn admission and close/reopen evidence proved
exact workspace isolation, unknown-ID fail-closed behavior, source-backed
canonical mutation and read-only inspection.

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

Reviewed head `d662f6e545e5be12d5f7937d45599f1f6c33c989` passed Security
Checks run `31025724234`, Benchmark Regression run `31025724138` and full
`npm test` job `92373576698`.

The adapter requires exact `auditId` plus workspace, enforces a maximum
`1024`-record scan, fails closed on malformed, duplicate and over-bound reads,
maps only source-backed fields, leaves `traceId` null and exposes no mutation,
approval or action method.

PR #255 reconciled it as live main
`d0b789e2e74049c09a1ae2ede063ed2a271d2b22`.

## Closed WB2 pure route contract

PR #256 authorized and PR #257 reconciled exactly:

```text
lib/workbench/memory-context-route.js
test/v4-wb2c-memory-context-route-contract.test.js
```

PR #258 implemented those owners at exact reviewed head:

```text
0156f0e0714dcf27c367a08d57a2cd4d38d18906
```

Exact-head evidence:

- Security Checks run `31027924345`: `SUCCESS`
- Benchmark Regression run `31027925257`: `SUCCESS`
- full `npm test` job `92381072592`: `SUCCESS`
- exact two-file scope: 103-line helper and 192-line test owner
- four commits ahead, zero behind, exact merge base
- zero open review threads

PR #258 merged as live main
`eed1d90a6c0f5b707ed25ff822265eb9b2038e43`.

The helper:

- exports only `ROUTE_PREFIX`, `parseWorkbenchMemoryContextPath` and
  `handleWorkbenchMemoryContextRequest`;
- reserves `/api/workbench/memory-context/`;
- requires exact non-empty audit ID and explicit workspace identity;
- rejects malformed, control-character, separator-bearing and oversized
  identity rather than truncating it;
- delegates through `createMemoryContextAuditSource()` and
  `inspectMemoryContext()` only;
- maps `ok`, `invalid_request`, `not_found` and `read_error` to `200`, `400`,
  `404` and `502`; and
- exposes no full receipt, arbitrary audit details, provenance, mutation,
  approval or action surface.

The helper remains pure. It is not required by `server.js`, and neither it nor
the audit-source adapter is yet listed in the npm package allowlist.

## Current gate

This reconciliation opens only:

```text
V4_WB2D_SERVER_WIRING_AUTHORIZATION
```

The next task must start from the exact post-reconciliation canonical `main`
and authorize one docs-only server-wiring gate before runtime files change.

The authorization must bind:

- exact `server.js` insertion point after the existing outer rate limit and URL
  parsing;
- `GET`-only method behavior;
- API-key rejection before adapter or inspector invocation;
- exact path audit ID and mandatory `workspaceId` query authority;
- `Cache-Control: no-store`, JSON content type, CORS and `nosniff` behavior on
  every WB2 response, including errors;
- exact status/body delegation from the pure route helper;
- package allowlist additions for
  `lib/workbench/memory-context-audit-source.js` and
  `lib/workbench/memory-context-route.js`;
- no-mock real-server smoke using real `Kernel` and SQLite-backed `Graph`;
- valid review and approved reads, unauthenticated, wrong method, malformed,
  oversized, unknown, cross-workspace and read-error paths;
- before/after nodes, edges and audit snapshots;
- WB3 and legacy receipt-route regressions; and
- packed/installed tarball server smoke.

The authorization itself is docs-only and may not modify runtime, tests,
package files, persistence, schema or dependencies.

## Remaining execution order

1. Authorize server wiring, package reachability and no-mock evidence.
2. Separately implement, review, merge and reconcile WB2 server wiring.
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
- No WB2 server, MCP, CLI or UI wiring in this reconciliation.
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
