# Current Operating Roadmap

**Live baseline:** `main` at
`fa906f8cd1bd983089bf842b42897ccf086f3975` (PR #249 V4-WB2 durable
runtime-source contract merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The bounded External Client Enablement-0 evidence program is closed. The
external-client HTTP adapter remains production-unreachable. The real
`server.js` does not register `POST /api/external-client/packages/admit` and has
no production trust profile, clock, replay path, SDK or mutation/receipt-owner
composition.

V4 Workbench runtime-evidence work is active. The Trust Receipt Inspector has
an authenticated product route and prior no-mock real-server evidence. The
Memory Admission / Context Integrity Inspector now has a proven sufficient
durable source contract through real Kernel, Graph, SQLite and learn-path
evidence, but no product adapter or route is implemented yet.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#151 | Coverage inventory, mutation ownership, immutable-source resolution, reviewed approval and receipt chain | No universal connector enforcement |
| #153 / #154 | Signed external-client package gate and SDK admission | No production HTTP authority mapping |
| #156-#171 | Version-aware receipt trust-root foundation and closeout | No global V2 writer or historical V1 rewrite |
| #173 / #174 | Default-closed Endpoint-0 contract | Requested configuration does not make route reachable |
| #175-#184 | Authority-0, replay-result recovery and adversarial authority matrix | No route or production composition |
| #185 / #186 | Enablement product decision and mandatory successor sequence | Successor evidence gates may not collapse |
| #187-#192 | Identity/Trust Config-0 | Pure materializer; no deployment loader |
| #193-#195 | Durable Replay-0 | Dedicated SQLite owner; remains production-unwired |
| #196-#198 | Mutation/Receipt Owner-0 | One exact quarantine and V2 receipt owner; no route |
| #202 / #225 / #226 / #228 / #230 | Adapter-0 authorization, implementation and reconciliation | Thin internal adapter only; no server registration |
| #231 / #232 | Route Adversarial-0 authorization and reconciliation | Exactly three test-owned files; production route forbidden |
| #235 / #236 / #239 / #240 | Observed-overflow correction and reconciliation | Native drain with bounded destroy fallback; no route or package change |
| #241 / #242 | Route Adversarial-0 reconstruction and reconciliation | Real-loopback evidence only; no production composition |
| #243 / #244 | Enablement-0 closeout audit authorization and reconciliation | Exact one-file docs audit only |
| #245 / #246 | Enablement-0 closeout audit and reconciliation | Bounded evidence closed; production route enablement remains blocked |
| #247 / #248 | V4-WB2 runtime-source authorization and reconciliation | One exact test-only source contract; no runtime or persistence |
| #249 | V4-WB2 durable runtime-source proof | Source sufficient; no adapter, route or public API |

## Closed External Client Enablement-0 evidence

PR #241 rebuilt the authorized real-loopback evidence using only:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

Its recovery head `a458ae995311125e17ef2ec5c530938bfddc87c5`
sent a truthful `1048577`-byte declared-overflow body and retained exact `413`
before delegation or durable mutation. Exact-head Security Checks run
`31014893750`, Benchmark Regression run `31014894014` and full `npm test` job
`92336329914` succeeded. PR #241 merged as
`4e681a5caec2d91ead9c1298da91c991c293dee0`; PR #242 reconciled it as
`1e733f57e333cd02e221d8e819eecd936bdfbca0`.

PR #245 then added exactly:

```text
docs/reports/external-client-enablement-0-closeout-audit.md
```

Its reviewed head `06983105ea79488bf996c7db8c13d6533274dec0`
passed Security Checks run `31018291572` and Benchmark Regression run
`31018291601`, then merged as
`9e8feaa0df803a81a5ffde80a765f20bb4b90942`. PR #246 reconciled the
closeout as `829e38f66c30ebe353cbab90b1d017fa68887c99`.

The bounded evidence program closed:

- static identity and trusted-key authority;
- durable SQLite replay ownership;
- bounded quarantine mutation and canonical V2 receipt ownership;
- thin HTTP adapter and fail-closed transport;
- real-loopback adversarial evidence;
- production route absence; and
- package, dependency and deployment non-expansion.

It did not authorize production route registration, production
profile/clock/replay/SDK/mutation composition, global V2 writer expansion, V4
completion or V5 implementation.

## Closed V4-WB2 durable source contract

PR #247 authorized one test-only characterization of whether current durable
audit records could feed the existing Memory Context Inspector without
inventing context, mutation or provenance semantics. PR #248 reconciled that
authorization and established exact implementation base
`182cd6a00d88bc4418d981ece4e1c9f168492b12`.

PR #249 changed exactly:

```text
test/v4-wb2-memory-context-runtime-source.test.js
```

Exact reviewed head:

```text
59942569d327249d9319e9228f79be17feeb80ae
```

Exact-head evidence:

- Security Checks run `31022647956`: `SUCCESS`
- Benchmark Regression run `31022647907`: `SUCCESS`
- full `npm test` job `92363082880`: `SUCCESS` in 262 seconds
- exact one-file, 273-line test scope
- two commits ahead, zero behind, exact merge base
- zero open review threads

PR #249 merged as live main
`fa906f8cd1bd983089bf842b42897ccf086f3975`.

The source contract used real `Kernel`, real SQLite-backed `Graph`, real learn
admission and real append-only audit records. It proved:

- a real review-required admission is queryable by exact `auditId` after
  SQLite close/reopen;
- a real approved admission ties canonical mutation only to a durable
  `LEARN`/`REAFFIRMED` edge audit and an existing canonical allow receipt;
- exact workspace filtering prevents cross-workspace leakage;
- unknown identifiers fail closed;
- receipt and provenance links are copied only when present; and
- lookup plus inspection do not mutate nodes, edges or audit rows.

The asserted verdict is:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

This proves only that a bounded read-only adapter can be designed from current
source. It does not prove product reachability, an HTTP route, authenticated
wiring or no-mock user-flow smoke.

## Current gate

This reconciliation opens only:

```text
V4_WB2B_AUDIT_SOURCE_ADAPTER_AUTHORIZATION
```

The next task must start from the exact post-merge canonical main produced by
this reconciliation and authorize one narrow read-only adapter boundary. The
authorization PR is docs-only and may not implement runtime.

The future adapter authorization must bind:

- one exact workspace and one exact audit ID;
- a bounded read from the current Graph audit owner;
- source-backed mapping of admission status, decision, reason, provenance,
  receipt link and canonical-mutation evidence;
- the existing `inspectMemoryContext()` helper as the sole output normalizer;
- fail-closed behavior for missing, ambiguous, malformed and cross-workspace
  records;
- no mutation of graph, audit, receipt, approval or memory state; and
- an exact implementation/test scope below the product route layer.

It must not authorize route registration, server wiring, new persistence,
Graph or Kernel domain changes, MCP/CLI/UI work, package expansion or V4
closeout. Route contract, authenticated product wiring and no-mock real-server
smoke remain later separate gates.

## Remaining execution order

### 1. WB2 read-only audit-source adapter

Authorize, implement, independently review and reconcile a bounded adapter from
current durable audit records into the existing inspector contract.

### 2. WB2 product-runtime surface

Separately authorize a route contract, authenticated server wiring and no-mock
real-server smoke. No combined route-and-adapter shortcut.

### 3. Remaining V4 gates

Complete bounded action/approval evidence, receipt inspection/export user-flow
smoke and V4 source/test/CI/release closeout in dependency order.

### 4. V5 successors

Only after V4 closeout: bounded A2A exchange, public-safe receipt policy,
external conformance and one real external integration.

## Permanent ordering rules

- One active task; every successor starts from exact post-merge canonical
  `main` and receives narrow authorization, implementation evidence, review and
  reconciliation.
- Production route registration remains closed unless separately authorized by
  a later product decision.
- Generic API key and rate limiting are transport guards, never external-client
  identity or authority.
- Identity, workspace, permissions, trusted keys, clock, replay, mutation and
  receipt ownership stay pre-bound outside request bytes.
- Positive replay restart and concurrency claims require real SQLite owners.
- Authority replay and mutation-journal replay must not be conflated.
- Unknown outcomes are never automatically retried or compensated.
- No `202 Accepted` or memory-only pending queue is introduced.
- Production V2 writer ownership is not inferred from transport or local test
  reachability.
- Historical V1 receipt bytes/hashes are never rewritten or backfilled.
- WB2 may not reconstruct missing context or provenance.
- A sufficient source contract is not product-runtime evidence by itself.
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No new WB2 persistence, schema, database table, migration or dependency.
- No WB2 route, server, MCP, CLI or UI implementation in the adapter
  authorization.
- No caller-controlled admission, receipt, workspace or mutation authority.
- No adding MemoryStore to the learn path.
- No global V2 switch or historical V1 rewrite.
- No package, dependency, version, release or deployment change.
- No V4-complete or V5-complete claim before their gates.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap and Graphify as unverified. Every delivery carries exact
base/head, scope, tests, CI, review, merge identity, non-claims and the
next-agent envelope.
