# Current Operating Roadmap

**Live baseline:** `main` at
`22377e4c276117271d67af4ad4ef7ab489c01e39` (PR #239 observed-overflow
correction merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The external-client HTTP adapter is implemented but production-unreachable.
The real `server.js` still does not register
`POST /api/external-client/packages/admit` and has no production profile, clock,
replay-path, SDK or mutation-owner composition.

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
| #234 | Unrelated V4-WB3 trust-receipt read surface | Baseline ancestry only; does not widen this gate |
| #235 / #236 | Observed-overflow correction authorization and reconciliation | Exactly adapter plus existing unit-test owner |
| #239 | Observed-overflow correction implementation | Native drain with bounded destroy fallback; no route or package change |

## Closed observed-overflow correction

Route Adversarial-0 PR #233 exposed one real transport conflict at
`test/external-client-route-adversarial.test.js:206`: the adapter selected
`413`, then reset the socket and the real loopback client observed `400`.
The assertion was not weakened.

PR #239 replaced the stale implementation branch and merged from exact head
`9acf1d598d55b8a858664165e359e3d69f9c30fb` at live main
`22377e4c276117271d67af4ad4ef7ab489c01e39`.

Exact changed files:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

Observed behavior:

- observed bytes above one MiB still select exact `413` before parsing or
  delegation;
- adapter listeners are detached before cleanup;
- native Node-compatible streams use `request.resume()` to drain unread bytes
  without resetting the socket before descriptor delivery;
- hostile streams without `resume()` retain bounded `request.destroy()`
  fallback;
- both cleanup paths explicitly prove zero `admitPackage` calls;
- malformed chunks, stream error/abort/close, timeout and declared-length
  failures retain their bounded fail-closed behavior; and
- no route, `server.js`, package, dependency, deployment, body-limit or timeout
  source changed.

Exact-head evidence:

- Security Checks `30993672632`: `SUCCESS`
- Benchmark Regression `30993672610`: `SUCCESS`
- open inline review threads: `0`
- exact two-file scope preserved

The closed PR #237 is historical only; it was superseded because current main
was not in its ancestry.

## Current gate

This reconciliation opens only:

```text
EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_RECONSTRUCTION
```

Start from exact canonical `main`
`22377e4c276117271d67af4ad4ef7ab489c01e39`.

Create a fresh branch and reconstruct the already-authorized evidence using
exactly:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

The stale PR #233 branch is not current ancestry evidence. Its source-backed
contract remains binding:

- real `server.js` remains generic `404` for disabled/requested endpoint states;
- one test-local real-loopback route composes the existing rate limiter,
  API-key guard, Adapter-0, pre-bound Authority/SDK, durable SQLite replay and
  mutation/receipt owner;
- observed and declared overflow both return exact `413` before mutation;
- concurrent duplicate and close/reopen replay evidence produce one durable
  outcome;
- Authority replay and mutation-journal replay remain distinct;
- response, durable candidate, journal result and canonical V2 receipt
  identifiers must agree;
- malformed transport, envelope, signature, package, identity, workspace,
  trust, freshness, replay and mutation authority inputs fail closed; and
- every authorized file remains at or below 300 physical lines.

Required validation:

```bash
node --test test/external-client-route-adversarial.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Exact-head Security Checks, full regression, scope review and final
source-first falsification are required before merge.

## Remaining execution order

### 1. Route Adversarial-0 reconstruction

Rebuild the exact three-file test-only candidate from current canonical main.
Do not change runtime or production composition.

### 2. Route Adversarial-0 reconciliation

After merge, record exact head, merge identity, scope, targeted/full-suite
results, CI and unchanged route/package boundaries.

### 3. External Client Enablement-0 closeout audit

Audit complete lineage, exact scopes, fail-closed boundaries, route absence,
package surface and non-claims. Production registration remains a later product
decision.

### 4. V4 Workbench successors

Complete the remaining read-only inspector, bounded action/approval,
receipt-export user-flow and V4 source/test/CI/release closeout evidence.

### 5. V5 successors

Only after V4 closeout: bounded A2A exchange, public-safe receipt policy,
external conformance and one real external integration.

## Permanent ordering rules

- One active task; every successor starts from exact post-merge canonical
  `main` and receives narrow authorization, implementation evidence, review and
  reconciliation.
- Route Adversarial-0 is evidence-only; `server.js` and production route
  registration remain closed.
- Generic API key and rate limiting are transport guards, never external-client
  identity or authority.
- Identity, workspace, permissions, trusted keys, clock, replay, mutation and
  receipt ownership stay pre-bound outside request bytes.
- Positive replay restart and concurrency claims require real SQLite owners.
- Authority replay and mutation-journal replay must not be conflated.
- Unknown outcomes are never automatically retried or compensated.
- No `202 Accepted` or memory-only pending queue is introduced.
- Existing Authority/package-gate publication remains source reality.
- Production V2 writer ownership is not inferred from transport or local test
  reachability.
- Historical V1 receipt bytes/hashes are never rewritten or backfilled.
- V4 is not complete without runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No `server.js`, deployment configuration or replay-path source change.
- No request-controlled authority.
- No weakening `413` to `400`, client reset or parser failure.
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
