# Current Operating Roadmap

**Live baseline:** `main` at
`cf39862a0001ab836919ca7fe2a45ed7199967ca` (PR #251 V4-WB2 audit-source
adapter authorization merge).

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
Memory Admission / Context Integrity Inspector has a sufficient durable source
contract, and a narrow internal audit-source adapter is now authorized but not
implemented. No WB2 product route exists.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#151 | Coverage inventory, mutation ownership, immutable-source resolution, reviewed approval and receipt chain | No universal connector enforcement |
| #153 / #154 | Signed external-client package gate and SDK admission | No production HTTP authority mapping |
| #156-#171 | Version-aware receipt trust-root foundation and closeout | No global V2 writer or historical V1 rewrite |
| #173-#198 | External endpoint, authority, replay and mutation/receipt ownership foundations | No production route composition |
| #202 / #225 / #226 / #228 / #230 | Adapter-0 authorization, implementation and reconciliation | Thin internal adapter only; no server registration |
| #231-#242 | Route adversarial authorization, overflow correction, reconstruction and reconciliation | Real-loopback evidence only; production route forbidden |
| #243-#246 | Enablement-0 closeout audit, merge and reconciliation | Bounded evidence closed; production enablement blocked |
| #247 / #248 | V4-WB2 durable-source authorization and reconciliation | One exact test-only contract; no runtime or persistence |
| #249 / #250 | V4-WB2 durable-source proof and reconciliation | Source sufficient; no adapter, route or public API |
| #251 | V4-WB2 audit-source adapter authorization | Exact internal adapter/test scope; no route or package publication |

## Closed External Client Enablement-0 evidence

PR #241 rebuilt the authorized real-loopback evidence using only:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

Its recovery head `a458ae995311125e17ef2ec5c530938bfddc87c5`
retained exact `413` before delegation or durable mutation. Security Checks run
`31014893750`, Benchmark Regression run `31014894014` and full `npm test` job
`92336329914` succeeded.

PR #245 added exactly
`docs/reports/external-client-enablement-0-closeout-audit.md` at reviewed head
`06983105ea79488bf996c7db8c13d6533274dec0`. Security Checks run
`31018291572` and Benchmark Regression run `31018291601` succeeded. PR #246
reconciled the closeout as live main
`829e38f66c30ebe353cbab90b1d017fa68887c99`.

The bounded evidence program closed static identity and trusted-key authority,
durable SQLite replay ownership, bounded mutation/canonical V2 receipt
ownership, thin fail-closed transport, real-loopback adversarial evidence,
production route absence and package/dependency/deployment non-expansion.

It did not authorize production route registration, production
profile/clock/replay/SDK/mutation composition, global V2 writer expansion, V4
completion or V5 implementation.

## Closed V4-WB2 durable source contract

PR #247 authorized one test-only characterization and PR #248 established exact
implementation base `182cd6a00d88bc4418d981ece4e1c9f168492b12`.

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

PR #249 merged as `fa906f8cd1bd983089bf842b42897ccf086f3975`.
PR #250 reconciled the verdict at reviewed head
`0f4630131cd84715c1a5a5127052c33a56f349dc` and merge/live main
`688af1d36599759746bf8cb6e2a4b9f010482466`.

The source contract used real `Kernel`, real SQLite-backed `Graph`, real learn
admission and durable audit records. It proved:

- review-required admission remains queryable after SQLite close/reopen;
- approved admission ties canonical mutation only to a durable
  `LEARN`/`REAFFIRMED` edge audit and existing canonical allow receipt;
- exact workspace filtering prevents cross-workspace leakage;
- unknown identifiers fail closed; and
- lookup plus inspection do not mutate graph or audit state.

The asserted verdict is:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

This is sufficient for a bounded internal read-only adapter. It is not product
reachability, authenticated routing or no-mock user-flow evidence.

## Closed V4-WB2 adapter authorization

PR #251 added exactly:

```text
docs/task-packs/v4-wb2-audit-source-adapter-authorization.md
```

Exact reviewed head:

```text
4e1d1ef646e47d2162ded994531229134314629a
```

Exact-head evidence:

- Security Checks run `31024924842`: `SUCCESS`
- Benchmark Regression run `31024925092`: `SUCCESS`
- exact one-file, 256-line docs scope
- one commit ahead, zero behind, exact merge base
- zero open review threads

PR #251 merged as live main
`cf39862a0001ab836919ca7fe2a45ed7199967ca`.

The authorization permits exactly one internal adapter and one test owner:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

The adapter must:

- select one exact `auditId` in one exact workspace;
- read through current `Graph.getAuditEvents({ workspaceId })` only;
- enforce a conservative default scan cap no greater than `1024`;
- fail closed on malformed returns, duplicate matches and bound overflow;
- map only source-backed admission, receipt and canonical-mutation fields;
- keep `contextIntegrity` under `memoryAdmission`;
- leave `traceId` null when no real trace identifier exists;
- delegate final output normalization to existing `inspectMemoryContext()`; and
- expose no mutation, approval or action method.

The authorization forbids changes to existing production files, route/server
wiring, persistence, schema, dependencies, package publication and relabeling
`provenanceId` or `sourceRef` as `traceId`.

## Current gate

This reconciliation opens only:

```text
V4_WB2B_AUDIT_SOURCE_ADAPTER_IMPLEMENTATION
```

The implementation candidate must start from exact canonical main
`cf39862a0001ab836919ca7fe2a45ed7199967ca` and add exactly:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

No existing production file may change.

Positive review and approved paths must use real `Kernel`, real SQLite-backed
`Graph`, real learn admission and close/reopen evidence. Minimal fake read
owners are allowed only for malformed return, duplicate exact identifier and
scan-cap branches that canonical Graph cannot produce.

Acceptance requires targeted tests, full `npm test`, unchanged package dry-run,
Graphify review, exact two-file scope, exact-head Security Checks and Benchmark
Regression, zero unresolved review threads and no state mutation caused by
adapter reads.

After the implementation merges, the next task is only
`V4_WB2B_AUDIT_SOURCE_ADAPTER_RECONCILIATION`. Product route work remains
unauthorized.

## Remaining execution order

### 1. WB2 read-only audit-source adapter

Implement the exact two-file adapter gate, review exact-head evidence, merge
and reconcile.

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
- Production route registration remains closed unless separately authorized.
- Identity, workspace, permissions, trusted keys, clock, replay, mutation and
  receipt ownership stay pre-bound outside request bytes.
- Unknown outcomes are never automatically retried or compensated.
- Production V2 writer ownership is not inferred from local test reachability.
- Historical V1 receipt bytes/hashes are never rewritten or backfilled.
- WB2 may not reconstruct missing context or provenance.
- `provenanceId` and `sourceRef` are not trace identifiers.
- A sufficient source contract or internal adapter is not product-runtime
  evidence by itself.
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No new WB2 persistence, schema, database table, index, migration or
  dependency.
- No WB2 route, server, MCP, CLI or UI implementation in the adapter gate.
- No caller-controlled admission, receipt, workspace or mutation authority.
- No full receipt or arbitrary audit-details exposure.
- No npm package-files expansion for the internal adapter.
- No global V2 switch or historical V1 rewrite.
- No package version, release or deployment change.
- No V4-complete or V5-complete claim before their gates.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap and Graphify as unverified. Every delivery carries exact
base/head, scope, tests, CI, review, merge identity, non-claims and the
next-agent envelope.
