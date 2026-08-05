# Current Operating Roadmap

**Live baseline:** `main` at
`e0b863fc1486488c891a55a0f7aa603a88851cd6` (PR #260 V4-WB2 server-wiring
authorization merge).

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

The Memory Admission / Context Integrity Inspector has:

- a proven durable source contract;
- a merged internal read-only audit-source adapter;
- a merged pure product route-contract helper; and
- an authorized server-wiring implementation gate.

WB2 is not yet registered or product-runtime proven.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256-#259 | WB2 pure route contract and reconciliation | Helper merged; route unreachable |
| #260 | WB2 server-wiring authorization | Exact four-file implementation; no runtime change yet |

## Closed WB2 source and adapter evidence

PR #249 proved `V4_WB2_RUNTIME_SOURCE_SUFFICIENT` at reviewed head
`59942569d327249d9319e9228f79be17feeb80ae`. It passed Security Checks run
`31022647956`, Benchmark Regression run `31022647907` and full `npm test` job
`92363082880` using real `Kernel`, SQLite-backed `Graph`, real admission and
close/reopen evidence.

PR #254 implemented exactly:

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

## Closed WB2 pure route contract

PR #258 implemented exactly:

```text
lib/workbench/memory-context-route.js
test/v4-wb2c-memory-context-route-contract.test.js
```

Exact reviewed head `0156f0e0714dcf27c367a08d57a2cd4d38d18906`
passed Security Checks run `31027924345`, Benchmark Regression run
`31027925257` and full `npm test` job `92381072592`.

The helper validates exact audit and workspace identity, rejects malformed or
oversized values without truncation, delegates through the adapter and
inspector, and maps bounded `200/400/404/502` responses. It remains pure and
unregistered.

PR #259 reconciled it as live main
`d4055983ebe1ce3dfda45ae5f0342908e6d07835`.

## Closed server-wiring authorization

PR #260 added exactly:

```text
docs/task-packs/v4-wb2-server-wiring-authorization.md
```

Exact reviewed head:

```text
864c57c39fca61481f4001a05da7fac2d4842838
```

Exact-head evidence:

- Security Checks run `31029445461`: `SUCCESS`
- Benchmark Regression run `31029446391`: `SUCCESS`
- exact one-file, 242-line docs scope
- two commits ahead, zero behind, exact merge base
- zero open review threads

PR #260 merged as live main
`e0b863fc1486488c891a55a0f7aa603a88851cd6`.

The authorization requires extraction of the existing inline WB3 route into a
bounded Workbench read-router seam rather than adding another domain block to
the oversized `server.js`.

## Current gate

This reconciliation opens only:

```text
V4_WB2D_SERVER_WIRING_IMPLEMENTATION
```

The implementation must start from exact canonical main
`e0b863fc1486488c891a55a0f7aa603a88851cd6` and change exactly:

```text
lib/workbench/workbench-read-http-router.js
server.js
package.json
test/v4-wb2d-memory-context-route-smoke.test.js
```

Required boundaries:

- new router at most `250` lines;
- new smoke owner at most `300` lines where practical;
- `server.js` net line growth non-positive;
- existing WB3 route semantics unchanged;
- WB2 exact raw workspace query with no sanitizing/truncating fallback;
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every WB2
  response;
- API-key rejection before Graph read;
- real `server.js`, real `Kernel`, SQLite-backed `Graph` and loopback HTTP;
- valid review and approved reads, malformed, oversized, unauthenticated,
  wrong-method, unknown, cross-workspace and over-1024-row read-error evidence;
- before/after nodes, edges and audit rows unchanged;
- WB3 and legacy receipt-route regressions;
- package allowlist additions only for the audit source, pure route and HTTP
  router modules; and
- installed-tarball server load evidence.

No lockfile, dependency, request guard, Graph, Kernel, MemoryStore, adapter,
inspector or pure route-contract change is authorized.

After implementation merges, only
`V4_WB2D_SERVER_WIRING_RECONCILIATION` may open the next gate.

## Remaining execution order

1. Implement, review, merge and reconcile WB2 server wiring.
2. Complete remaining V4 action/approval, receipt-export user-flow and closeout
   gates.
3. Begin V5 successors only after V4 closeout and external interoperability.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- No production route registration without separate authorization.
- Identity and workspace authority remain pre-bound and explicit.
- Missing context or provenance is never reconstructed.
- `provenanceId` and `sourceRef` are not trace identifiers.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No external-client production route.
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
