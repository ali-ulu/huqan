# Current Operating Roadmap

**Live baseline:** `main` at
`cab8f49b4111b73605bebc86124446cb6d283939` (PR #254 V4-WB2 audit-source
adapter implementation merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The bounded External Client Enablement-0 evidence program is closed. Its HTTP
adapter remains production-unreachable: `server.js` does not register the
external-client admission route and has no production trust profile, clock,
replay, SDK or mutation/receipt-owner composition.

V4 Workbench runtime-evidence work is active. The Trust Receipt Inspector has
an authenticated product route and prior no-mock real-server evidence. The
Memory Admission / Context Integrity Inspector now has both a proven durable
source contract and a merged internal read-only audit-source adapter. WB2 still
has no authenticated product route or no-mock product-runtime evidence.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#151 | Coverage inventory, mutation ownership, immutable-source resolution, reviewed approval and receipt chain | No universal connector enforcement |
| #153-#198 | Signed package, receipt trust-root and bounded external authority/replay/mutation foundations | No production route composition |
| #202 / #225-#242 | Internal adapter and real-loopback adversarial evidence | Production route forbidden |
| #243-#246 | External Client Enablement-0 closeout and reconciliation | Bounded evidence closed; production enablement blocked |
| #247 / #248 | V4-WB2 durable-source authorization and reconciliation | Test-only source contract |
| #249 / #250 | V4-WB2 durable-source proof and reconciliation | Source sufficient; no adapter or route |
| #251 / #252 | V4-WB2 adapter authorization and reconciliation | Exact two-file internal adapter scope |
| #254 | V4-WB2 audit-source adapter implementation | Internal read-only adapter; no product route |

## Closed external-client evidence

PR #241 retained exact `413` before delegation or durable mutation at reviewed
head `a458ae995311125e17ef2ec5c530938bfddc87c5`. Security Checks run
`31014893750`, Benchmark Regression run `31014894014` and full `npm test` job
`92336329914` succeeded.

PR #245 added the one-file Enablement-0 closeout audit at reviewed head
`06983105ea79488bf996c7db8c13d6533274dec0`. Security Checks run
`31018291572` and Benchmark Regression run `31018291601` succeeded. PR #246
reconciled that bounded program as live main
`829e38f66c30ebe353cbab90b1d017fa68887c99`.

This evidence closes bounded identity/trusted-key authority, durable SQLite
replay, mutation/canonical V2 receipt ownership, thin fail-closed transport,
real-loopback adversarial behavior and production route absence. It does not
authorize production registration or composition.

## Closed V4-WB2 durable source contract

PR #249 changed exactly:

```text
test/v4-wb2-memory-context-runtime-source.test.js
```

Exact reviewed head `59942569d327249d9319e9228f79be17feeb80ae`
passed:

- Security Checks run `31022647956`;
- Benchmark Regression run `31022647907`; and
- full `npm test` job `92363082880`.

It used real `Kernel`, real SQLite-backed `Graph`, real learn admission and
close/reopen evidence. It proved review and approved records remain durable,
workspace isolation is exact, unknown identifiers fail closed, canonical
mutation is tied to an actual edge audit plus existing canonical allow receipt,
and inspection does not mutate state.

The source-backed verdict is:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

PR #250 reconciled that verdict as live main
`688af1d36599759746bf8cb6e2a4b9f010482466`.

## Closed V4-WB2 adapter implementation

PR #251 authorized one internal read-only audit-source adapter and one test
owner. PR #252 reconciled the authorization and established implementation base
`cf528cd547fb3f14ca62f108c5916db611287e04`.

PR #254 changed exactly:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

Exact reviewed head:

```text
d662f6e545e5be12d5f7937d45599f1f6c33c989
```

Exact-head evidence:

- Security Checks run `31025724234`: `SUCCESS`
- Benchmark Regression run `31025724138`: `SUCCESS`
- full `npm test` job `92373576698`: `SUCCESS`
- exact two-file scope: 132-line adapter and 265-line test owner
- four commits ahead, zero behind, exact merge base
- zero open review threads

PR #254 merged as live main
`cab8f49b4111b73605bebc86124446cb6d283939`.

The merged adapter:

- exports only `createMemoryContextAuditSource`;
- exposes only `readMemoryContext({ recordId, workspaceId })`;
- requires exact non-empty audit ID and workspace;
- reads through current `Graph.getAuditEvents({ workspaceId })` only;
- enforces a default and maximum scan cap of `1024`;
- fails closed on malformed results/events/receipts, duplicate exact matches and
  bound overflow;
- maps only source-backed decision, status, reason, receipt ID and canonical
  mutation evidence;
- keeps `traceId` null rather than relabeling `provenanceId` or `sourceRef`;
- delegates final normalization to existing `inspectMemoryContext()`; and
- exposes no mutation, approval or action method.

Positive tests used real `Kernel`, SQLite-backed `Graph`, real admission and
close/reopen persistence. Minimal fake owners were limited to malformed,
duplicate and bounds branches.

No existing production owner, route, server, Graph, Kernel, persistence,
schema, migration, dependency, package surface, release or deployment changed.
The adapter is not product-runtime reachability evidence by itself.

## Current gate

This reconciliation opens only:

```text
V4_WB2C_PRODUCT_ROUTE_CONTRACT_AUTHORIZATION
```

The next task must start from the exact post-reconciliation canonical `main`
and authorize one docs-only route contract before any product wiring begins.

The contract must identify:

- exact authenticated route and method;
- pre-bound identity and workspace authority;
- exact audit-record identifier authority;
- request header/body/query bounds and malformed-input behavior;
- API-key/rate-limit ordering;
- adapter and inspector call chain;
- HTTP status and bounded response mapping;
- no-store and security-header behavior;
- package/public reachability decision;
- no-mock real-server smoke scenarios; and
- later implementation and reconciliation scopes.

The authorization may not implement or modify runtime, route, server, tests,
package files, persistence, schema or dependencies.

## Remaining execution order

### 1. WB2 product route contract

Authorize one exact-base docs-only contract. Then separately implement,
review, merge and reconcile authenticated product wiring plus no-mock
real-server evidence.

### 2. Remaining V4 gates

Complete bounded action/approval evidence, receipt inspection/export user-flow
smoke and V4 source/test/CI/release closeout in dependency order.

### 3. V5 successors

Only after V4 closeout: bounded A2A exchange, public-safe receipt policy,
external conformance and one real external integration.

## Permanent ordering rules

- One active task; every successor starts from exact post-merge canonical
  `main` and receives narrow authorization, implementation evidence, review and
  reconciliation.
- Production route registration remains closed unless separately authorized.
- Identity, workspace, permissions, trusted keys, clock, replay, mutation and
  receipt ownership stay pre-bound outside request bytes.
- Unknown outcomes are never automatically retried or compensated.
- Historical V1 receipt bytes/hashes are never rewritten or backfilled.
- WB2 may not reconstruct missing context or provenance.
- `provenanceId` and `sourceRef` are not trace identifiers.
- A source contract or internal adapter is not product-runtime evidence.
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No new WB2 persistence, schema, table, index, migration or dependency.
- No caller-controlled admission, receipt, workspace or mutation authority.
- No full receipt or arbitrary audit-details exposure.
- No npm package-files expansion for the internal adapter.
- No global V2 switch or historical V1 rewrite.
- No package version, release or deployment change.
- No V4-complete or V5-complete claim before their gates.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
