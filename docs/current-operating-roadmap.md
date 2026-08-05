# Current Operating Roadmap

**Live baseline:** `main` at
`4e681a5caec2d91ead9c1298da91c991c293dee0` (PR #241 Route
Adversarial-0 reconstruction merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The external-client HTTP adapter exists but remains production-unreachable.
The real `server.js` does not register
`POST /api/external-client/packages/admit` and has no production trust profile,
clock, replay path, SDK or mutation/receipt-owner composition.

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
| #241 | Route Adversarial-0 reconstruction | Real-loopback evidence only; no production composition |

## Closed Route Adversarial-0 reconstruction

PR #241 rebuilt the already-authorized real-loopback evidence from exact base
`cea7714bb0768890c1e9ec380e4ff116e357e4ff` using only:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

The first candidate head `d025ec5dd801c0e7b4990ffd6f36857e7d6b5c98`
failed one exact assertion. The declared-overflow fixture advertised
`Content-Length: 1048577` but sent an empty request body, so the real Node HTTP
transport returned `400` before the intended application-level `413` evidence
could be observed.

Recovery head `a458ae995311125e17ef2ec5c530938bfddc87c5` did not weaken
the contract. It sent the truthful `1048577`-byte body and retained exact
`413` before delegation or durable mutation.

Exact-head evidence:

- Security Checks run `31014893750`: `SUCCESS`
- Benchmark Regression run `31014894014`: `SUCCESS`
- full `npm test` job `92336329914`: `SUCCESS`
- open inline review threads: `0`
- exact three-file test-owned scope preserved
- production runtime, route, server, package, dependency and deployment source
  unchanged

PR #241 merged at exact reviewed head
`a458ae995311125e17ef2ec5c530938bfddc87c5`; merge/live main is
`4e681a5caec2d91ead9c1298da91c991c293dee0`.

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

## Current gate

This reconciliation opens only:

```text
EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT_AUTHORIZATION
```

The authorization must start from exact canonical `main`
`4e681a5caec2d91ead9c1298da91c991c293dee0` and define a docs-only audit
scope before any closeout work begins.

The closeout audit must attempt to falsify:

- complete predecessor lineage and exact merge identities;
- exact scopes and negative scopes for every enablement successor;
- route absence and default-closed production behavior;
- request-independent identity, workspace, permissions, trusted keys, clock,
  replay, mutation and receipt authority;
- fail-closed transport, replay, concurrency and unknown-outcome behavior;
- npm package surface and deployment non-expansion;
- bounded production V2 receipt ownership and historical V1 byte/hash
  preservation; and
- all Enablement-complete, V4-complete and V5-complete non-claims.

No runtime, route, `server.js`, package, dependency, deployment or release
change is authorized by this reconciliation.

## Remaining execution order

### 1. Enablement-0 closeout audit authorization

Create one exact-base docs-only authorization with acceptance criteria,
forbidden claims and an explicit write lock.

### 2. Enablement-0 closeout audit

Audit live source, exact Git lineage, tests, CI, package surface and production
route absence. A document-only claim is not evidence.

### 3. Closeout reconciliation

Record the exact reviewed head, merge identity, scope and audit result before
moving to V4 successors.

### 4. V4 Workbench successors

Complete remaining read-only inspector, bounded action/approval,
receipt-export user-flow and V4 source/test/CI/release closeout evidence.

### 5. V5 successors

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
- No Enablement-complete, V4-complete or V5-complete claim before their gates.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap and Graphify as unverified. Every delivery carries exact
base/head, scope, tests, CI, review, merge identity, non-claims and the
next-agent envelope.