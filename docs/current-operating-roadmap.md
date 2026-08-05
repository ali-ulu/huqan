# Current Operating Roadmap

**Live baseline:** `main` at
`9e8feaa0df803a81a5ffde80a765f20bb4b90942` (PR #245 External Client
Enablement-0 closeout audit merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The bounded External Client Enablement-0 evidence program is closed. The
external-client HTTP adapter still remains production-unreachable. The real
`server.js` does not register `POST /api/external-client/packages/admit` and has
no production trust profile, clock, replay path, SDK or mutation/receipt-owner
composition.

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
| #245 | Enablement-0 closeout audit | Bounded evidence closed; production route enablement remains blocked |

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

PR #245 merge/live main is
`9e8feaa0df803a81a5ffde80a765f20bb4b90942`.

The audit closed these bounded evidence boundaries:

- static identity and trusted-key authority;
- durable SQLite replay ownership;
- bounded quarantine mutation and canonical V2 receipt ownership;
- thin HTTP adapter and fail-closed transport;
- real-loopback adversarial evidence;
- production route absence; and
- package, dependency and deployment non-expansion.

The audit did not authorize production enablement. These remain blocked:

- production route registration and reachability;
- production profile, trusted clock, replay path, SDK and mutation/receipt
  composition;
- global production V2 writer expansion;
- V4 Workbench completion; and
- V5 ecosystem implementation or completion.

Connector-only limits remain explicit: local clone bootstrap,
`node scripts/agent-context.js`, local worktree state, local `git diff --check`,
local package dry-run and Graphify refresh were not re-run by the connector.

## Current gate

This reconciliation opens only:

```text
V4_WORKBENCH_RUNTIME_EVIDENCE_0_AUTHORIZATION
```

The next task must start from the exact post-merge canonical `main` produced by
this reconciliation and authorize one narrow V4 Workbench runtime-evidence
slice. It may not implement runtime, UI, action, approval or receipt-export
behavior in the authorization PR.

The authorization must first select and bound one existing V4 evidence gap:

- proving the read-only Workbench inspectors through a real product runtime
  path;
- binding one bounded fail-closed action/approval surface;
- proving receipt inspection/export through a real user flow; or
- closing V4 source, test, CI and release evidence after predecessor slices are
  complete.

The first slice should prefer the smallest prerequisite-complete boundary and
must identify exact production/test owners, acceptance commands, negative
scope, no-mock smoke requirements and the later reconciliation step.

## Remaining execution order

### 1. V4 Workbench runtime-evidence authorization

Authorize one exact-base, narrow V4 evidence slice. The authorization is docs
only and may not combine implementation with product decisions or closeout.

### 2. V4 Workbench successors

Implement and reconcile the authorized read-only inspector, bounded
action/approval, receipt-export user-flow and final V4 source/test/CI/release
evidence in dependency order.

### 3. V5 successors

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
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No `server.js`, deployment configuration or replay-path source change.
- No request-controlled authority.
- No weakening `413` to `400`, client reset or parser-failure evidence.
- No new adapter status, header, response field or socket-control API.
- No queue, retry or compensation.
- No package, dependency, version, release or deployment change.
- No global V2 switch or historical V1 rewrite.
- No multi-client, internet, TLS or reverse-proxy claim.
- No V4-complete or V5-complete claim before their gates.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap and Graphify as unverified. Every delivery carries exact
base/head, scope, tests, CI, review, merge identity, non-claims and the
next-agent envelope.
