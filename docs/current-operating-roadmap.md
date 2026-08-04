# Current Operating Roadmap

**Live baseline:** `main` at
`446154de502b45e95e07b4b934d641fb7a9ed058` (PR #235 observed-overflow
amendment merge).

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
| #235 | Observed-overflow Adapter-0 amendment | Exactly adapter plus existing unit-test owner |

## Route Adversarial-0 blocker

PR #233 exact head
`931a5539af5f68b323e3fe272be993f7d07606b5` implemented the authorized
three-file real-loopback evidence harness.

The runtime/test job `92132051354` failed at:

```text
test/external-client-route-adversarial.test.js:206
actual 400, expected 413
```

Line 206 is the chunked **observed-byte overflow** assertion. The preceding
declared `Content-Length` overflow case is distinct.

Source review found:

1. Adapter-0 detects the observed overflow and selects frozen `413`.
2. Its body reader finishes with stream stopping enabled.
3. `stop(request)` prefers `IncomingMessage.destroy()`.
4. The real transport is reset before the harness can copy the selected
   descriptor to the socket.
5. The existing unit request double records `destroy()` without reproducing a
   real socket reset.

This is a runtime transport-contract defect, not a SQLite/native-module failure
and not permission to accept `400`.

PR #233 is therefore blocked as:

```text
EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_BLOCKED_CONTRACT_CONFLICT
```

The line-206 `413` expectation, real HTTP client and socket proof remain
unchanged. No harness facade or destruction shim may mask the defect.

## Closed observed-overflow amendment

PR #235 merged at
`446154de502b45e95e07b4b934d641fb7a9ed058` from exact head
`2f11047fefe1150b43b92883edfe2c45f772cd8e`.

It authorizes a successor changing exactly:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

Required correction:

- observed bytes above one MiB still select `413` before parsing/delegation;
- unread request bytes are released or drained without resetting the socket
  before the caller writes the descriptor;
- declared overflow, malformed chunks, stream error/abort/close, timeout,
  listener cleanup and no-delegation behavior remain bounded;
- no new status, header, response field, dependency, helper, registry,
  configurable limit, route, package or deployment surface is introduced; and
- both authorized files remain at or below 300 physical lines.

PR #235 exact-head Security Checks `30955486962` and Benchmark Regression
`30955486971` succeeded.

## Current gate

This reconciliation opens only:

```text
EXTERNAL_CLIENT_HTTP_ADAPTER_0_OBSERVED_OVERFLOW_IMPLEMENTATION
```

Start from exact canonical `main`
`446154de502b45e95e07b4b934d641fb7a9ed058`.

The minimum implementation should reuse the native readable-stream drain/release
primitive after adapter listeners are detached. It must not destroy a real
request socket before descriptor delivery. Hostile non-Node-compatible streams
still settle once and fail closed.

Required validation:

```bash
node --test lib/external-client-http-adapter.test.js
node --test test/external-client-route-adversarial.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

The route test is validation evidence only in this correction; its file is not
authorized to change.

## Remaining execution order

### 1. Adapter-0 observed-overflow implementation

Change exactly the adapter and its existing unit-test owner. Prove descriptor
selection, native drain/release behavior, bounded fallback, exact cleanup and no
delegation.

### 2. Adapter-0 correction reconciliation

Record exact source, targeted/full-suite counts when available, CI, review,
merge identity and unchanged package/route boundaries.

### 3. Route Adversarial-0 reconstruction

Rebuild PR #233 from then-current canonical `main`, preserving exactly its three
authorized test files and unchanged real-HTTP `413` proof. Rerun targeted tests,
full suite, package dry-run, real SQLite restart/concurrency and durable
candidate/journal/receipt assertions.

### 4. Route Adversarial-0 reconciliation

Close only after exact-head CI, source-first review, merge and post-merge smoke.

### 5. External Client Enablement-0 closeout audit

Audit complete lineage, exact scopes, fail-closed boundaries, route absence,
package surface and non-claims. Production registration remains a later product
decision.

### 6. V4 and V5 successors

V4 requires remaining Workbench runtime/user-flow evidence and closeout. V5
requires V4 closeout plus bounded A2A exchange, external conformance and one
real external integration before ecosystem claims.

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
base/head, scope, tests, CI, review, merge identity, non-claims and the next-agent
envelope.
