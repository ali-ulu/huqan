# Current Operating Roadmap

**Live baseline:** `main` at
`e5277e03a6f846f4af540d827b672c656eb5afc7` (PR #247 V4-WB2 runtime-source
authorization merge).

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
remaining V4-B1 gap is the Memory Admission / Context Integrity Inspector,
which is currently a read-only helper proven only against supplied test data.

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
| #247 | V4-WB2 runtime-source authorization | One future test-only source-reality gate; no runtime or persistence |

## Closed Route Adversarial-0 evidence

PR #241 rebuilt the already-authorized real-loopback evidence from exact base
`cea7714bb0768890c1e9ec380e4ff116e357e4ff` using only:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

The first candidate head `d025ec5dd801c0e7b4990ffd6f36857e7d6b5c98`
sent an internally inconsistent declared-overflow request: it advertised
`Content-Length: 1048577` but sent an empty body. The real transport returned
`400` before the intended application-level `413` could be observed.

Recovery head `a458ae995311125e17ef2ec5c530938bfddc87c5` sent the truthful
`1048577`-byte body and retained exact `413` before delegation or durable
mutation. It did not modify runtime or weaken the assertion.

Exact-head evidence:

- Security Checks run `31014893750`: `SUCCESS`
- Benchmark Regression run `31014894014`: `SUCCESS`
- full `npm test` job `92336329914`: `SUCCESS`
- open inline review threads: `0`
- exact three-file test-owned scope preserved

PR #241 merged at exact reviewed head
`a458ae995311125e17ef2ec5c530938bfddc87c5`; merge main was
`4e681a5caec2d91ead9c1298da91c991c293dee0`.

PR #242 reconciled that merge using only the mutable checkpoint and operating
roadmap. It merged at exact reviewed head
`d09962a89480526d03e636f405c7d22e1fb55551`; merge main was
`1e733f57e333cd02e221d8e819eecd936bdfbca0`.

Observed boundaries remain:

- the real server is generic `404` for disabled and requested endpoint states;
- outer rate limiting and API-key guards reject before adapter, replay or
  mutation;
- one test-local route composes Adapter-0, pre-bound Authority/SDK, real SQLite
  replay and mutation/receipt ownership;
- valid admission returns exact `201` with matching response, candidate,
  journal and canonical V2 receipt identifiers;
- concurrent duplicates and close/reopen replay yield one durable mutation;
- Authority replay and mutation-journal replay remain distinct;
- declared and observed byte overflow return exact `413` before delegation;
- malformed transport, envelope, signature, package, identity, workspace,
  trust, freshness, replay and mutation inputs fail closed; and
- abort and unknown-outcome paths do not retry.

## Closed External Client Enablement-0 audit

PR #243 authorized one docs-only External Client Enablement-0 closeout audit.
PR #244 reconciled that authorization and established exact audit base
`f05305bad2097d4025ac691648dbe32a77abf04d`.

PR #245 added exactly:

```text
docs/reports/external-client-enablement-0-closeout-audit.md
```

Exact reviewed head:

```text
06983105ea79488bf996c7db8c13d6533274dec0
```

Exact-head evidence:

- Security Checks run `31018291572`: `SUCCESS`
- Benchmark Regression run `31018291601`: `SUCCESS`
- docs-only runtime test, Docker and benchmark classifications completed as
  `SUCCESS` / `NOT_APPLICABLE`
- exact one-file authorized scope
- zero open review threads

PR #245 merge/live main was
`9e8feaa0df803a81a5ffde80a765f20bb4b90942`.

PR #246 reconciled the closeout using exactly the mutable checkpoint and
operating roadmap. Its reviewed head was
`697db7394e0549c7893b320497ed9c9fdf228332`; merge/live main was
`829e38f66c30ebe353cbab90b1d017fa68887c99`.

The audit closed these bounded evidence boundaries:

- static identity and trusted-key authority;
- durable SQLite replay ownership;
- bounded quarantine mutation and canonical V2 receipt ownership;
- thin HTTP adapter and fail-closed transport;
- real-loopback adversarial evidence;
- production route absence; and
- package, dependency and deployment non-expansion.

The audit did not authorize production enablement. Production route
registration, production profile/clock/replay/SDK/mutation composition, global
V2 writer expansion, V4 completion and V5 implementation remain blocked.

## Closed V4-WB2 runtime-source authorization

PR #247 selected the remaining V4-B1 Memory Admission / Context Integrity
Inspector boundary and authorized a single test-only source-reality gate.

Exact changed file:

```text
docs/task-packs/v4-wb2-memory-context-runtime-evidence-authorization.md
```

Exact reviewed head:

```text
c81aaa7b1a08691b7d6c0e7596919b43cf9acade
```

Exact-head evidence:

- Security Checks run `31021754841`: `SUCCESS`
- Benchmark Regression run `31021754924`: `SUCCESS`
- exact one-file docs scope
- one commit ahead, zero behind, exact merge base
- zero open review threads

PR #247 merge/live main is
`e5277e03a6f846f4af540d827b672c656eb5afc7`.

The authorization records these source facts:

- `lib/workbench/memory-context-inspector.js` is read-only but not yet proven
  through a durable product-runtime source;
- its current WB2 test supplies a transient MCP result, artificial record ID
  and in-memory source;
- `Graph` owns an append-only SQLite-backed audit log;
- the real learn path appends review/reject/admitted audit evidence and copies
  existing admission receipts without fabricating them; and
- current durable audit records have not yet been proven sufficient to feed
  WB2 without inventing absent semantics.

No runtime adapter, route, store, migration, dependency or public API was
authorized by PR #247.

## Current gate

This reconciliation opens only:

```text
V4_WB2A_MEMORY_CONTEXT_RUNTIME_SOURCE_CONTRACT_TESTS
```

The implementation candidate must start from exact canonical `main`
`e5277e03a6f846f4af540d827b672c656eb5afc7` and change exactly:

```text
test/v4-wb2-memory-context-runtime-source.test.js
```

The test-only gate must use real `Kernel`, `Graph` and SQLite owners to prove or
falsify whether current durable audit records can feed the existing WB2 helper
without synthetic context, mutation or provenance claims.

It must end with exactly one source-backed verdict:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
V4_WB2_RUNTIME_SOURCE_BLOCKED_GAP
```

If sufficient, the next task is post-merge reconciliation followed by a
separate audit-source adapter authorization. If insufficient, the next task is
post-merge reconciliation followed by a separate persistence product-decision
authorization. The test PR may not repair runtime.

## Remaining execution order

### 1. WB2 durable source contract

Implement the exact one-file test gate, review exact-head evidence, merge and
reconcile its `SUFFICIENT` or `BLOCKED_GAP` verdict.

### 2. WB2 product-runtime surface

Only after a sufficient source contract: separately authorize and implement a
read-only source adapter, route contract, authenticated product wiring and
no-mock real-server smoke.

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
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No new WB2 persistence, schema, database table, migration or dependency.
- No WB2 route, server, MCP, CLI or UI implementation in the test gate.
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
