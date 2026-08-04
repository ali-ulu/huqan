# Current Operating Roadmap

**Live baseline:** `main` at
`8bfb79adc5e95f7c2be929deb8a554f5f349b894` (PR #231 Route Adversarial-0
authorization merge).

This is the compact execution-order source. Live source, tests, exact Git SHA
and CI outrank this document. Detailed history remains in merged PRs,
task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, immutable-source handling, signed package
admission, canonical receipts, one bounded external-client trust profile
materializer, one dedicated SQLite replay owner, one exact candidate
mutation/receipt owner and one thin HTTP adapter.

The external-client HTTP adapter is implemented but unreachable. The real
`server.js` still does not register
`POST /api/external-client/packages/admit`, does not import the adapter and has
no production profile, clock, replay-path, SDK or mutation-owner composition.
Endpoint configuration `requested` remains unready and preserves generic `404`.

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
| #202 / #225 / #226 / #228 / #230 | Mutation-owner reconciliation, Adapter-0 authorization, implementation and reconciliation | Thin internal adapter only; no server registration |
| #231 | Route Adversarial-0 authorization | Test-only evidence harness; production route remains forbidden |

## Closed HTTP Adapter-0 boundary

PR #228 merged as
`4360c03c163fe4d8189ccb5d3c1c9845ce50b3f5` from exact head
`7116ee79dfe8ba13a7af50f4e665cd367985b8ea` with only:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

The adapter:

- accepts exact `POST` and exact JSON media types;
- enforces one MiB, five-second, fatal UTF-8, depth-32 and aggregate-10,000
  request bounds;
- accepts exactly `{ package, signature }`;
- rejects conflicting normalized/raw content-type and content-length views;
- delegates once to one pre-bound `admitPackage` dependency;
- returns frozen secret-free `201` or exact journal-replay `200` descriptors;
- maps unknown outcomes to bounded `503` without retry or compensation;
- never returns `202` or owns a queue; and
- imports no SDK, Authority, trust, replay, mutation, Graph, Kernel or server
  owner.

Exact-head Security Checks `30927539033`, Benchmark Regression `30927539194`
and rerun runtime/full-suite job `92054400176` succeeded. The connector did not
return the successful rerun's exact count; no count is invented.

PR #230 reconciled that implementation as docs-only merge
`01e190b882a9dbf3daf306fd368b135ce83eec63`.

## Closed Route Adversarial-0 authorization

PR #231 merged as
`8bfb79adc5e95f7c2be929deb8a554f5f349b894` from exact head
`07c53a029bbc0c9b819790626b237b1cce68dd60`.

The single task-pack authorizes exactly:

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

Each file is limited to 300 physical lines.

The successor is evidence-only. It may build an ephemeral loopback HTTP harness
that composes existing owners in this order:

```text
checkRateLimit
  -> requireApiKey
  -> HTTP Adapter-0
  -> pre-bound SDK/Authority-0
  -> Durable Replay-0
  -> Mutation/Receipt Owner-0
  -> Graph SQLite journal and receipt
```

It must prove:

- real server generic `404` for disabled and requested states;
- rate-limit then API-key rejection before adapter/body/replay/mutation;
- request authority limited to package and signature;
- one valid `201` quarantine with one candidate, completed journal record and
  canonical `external_verified_client` V2 receipt whose IDs match the response;
- identical concurrent requests produce one allow and one replay rejection;
- replay-store close/reopen rejects identical evidence without a second
  mutation;
- Authority replay and mutation-journal replay are distinct, with `200` only
  for the latter exact replay result;
- malformed transport, caller authority, signature, key, freshness, scope and
  package failures create no domain rows;
- handler, replay and unknown mutation outcomes never retry;
- no secret or internal evidence leaks;
- all servers, timers, stores, Graph databases and temporary files close; and
- `npm pack --dry-run` preserves the actual current surface.

The package-boundary correction is explicit: current packaging already includes
existing Authority and package-gate modules. Route Adversarial-0 must not claim
their removal. Endpoint contract, trust materializer, replay owner, mutation
owner, HTTP adapter and all new tests remain excluded.

PR #231 exact-head Security Checks `30944561536` and Benchmark Regression
`30944561814` succeeded. Runtime/test, Benchmark and Docker workloads were
`NOT_APPLICABLE`. Source-first review `4858355464` and final Lead review
`4858357561` passed under the transparently labeled single-operator continuity
precedent; no independent external-model approval is claimed.

## Current reconciliation state

This docs-only reconciliation records the PR #231 authorization merge and opens
only:

```text
EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_IMPLEMENTATION
```

It changes only the mutable checkpoint and operating roadmap. It does not add
tests, compose owners, register a route, change server behavior or alter the
package surface.

## Remaining execution order

### 1. Route Adversarial-0 implementation

Start from the exact post-reconciliation canonical `main`. Change exactly the
three authorized test-owned files and keep each at or below 300 lines.

Required evidence includes targeted tests, full suite, package dry-run, exact
scope/line counts, real SQLite restart/concurrency, real HTTP smoke, static
route absence and clean resource shutdown.

### 2. Route Adversarial-0 post-merge reconciliation

Record exact source, targeted/full-suite counts when available, CI, durable
state evidence, package boundary, review, merge and canonical-main identity.

### 3. External Client Enablement-0 closeout audit

Audit complete lineage, exact scopes, fail-closed boundaries, route absence,
package surface and non-claims. The closeout may classify the bounded local
evidence foundation as complete while production route registration and
deployment remain explicitly closed.

### 4. V4 open items

1. Workbench runtime evidence;
2. bounded approval/action surface;
3. receipt inspection and export/import user-flow smoke;
4. V4 source/test/CI/release closeout.

### 5. V5 ecosystem items

1. bounded A2A exchange;
2. external conformance runner;
3. one real external integration;
4. GitHub App beta before Streaming Trust;
5. Certified Node and TrustBench drafts without truth or launch overclaims.

## Permanent ordering rules

- Every successor starts from exact post-merge canonical `main` and receives its
  own narrow authorization, implementation evidence, review and reconciliation.
- Route Adversarial-0 is test-only; `server.js` and production route registration
  remain closed.
- Generic API key and rate limiting are transport guards, never identity,
  workspace, permission, key, trust-root or replay authority.
- Identity, workspace, permissions, trusted keys, clock, replay, mutation and
  receipt ownership stay pre-bound outside request bytes.
- Positive replay restart and concurrency claims require real SQLite owners.
- Authority replay and mutation-journal replay must not be conflated.
- Unknown outcomes are never automatically retried or compensated.
- No `202 Accepted` or memory-only pending queue is introduced.
- Existing Authority/package-gate publication is source reality; no task may
  silently claim or perform its removal.
- Production V2 writer ownership is not inferred from transport or local test
  reachability.
- V4 is not complete without real runtime and user-flow evidence.
- V5 is not complete without V4 closeout and external interoperability.

## Explicit non-goals

- No production external-client route registration or reachability.
- No `server.js`, deployment configuration or replay-path source change.
- No request-controlled authority.
- No memory/JSON replay substitute for positive evidence.
- No queue, `202`, retry or compensation.
- No runtime, package, dependency, version, release or deployment change in the
  authorization reconciliation.
- No global V2 switch, historical V1 rewrite or trust-root backfill.
- No multi-client, multi-process, internet, TLS or reverse-proxy claim.
- No Enablement-closeout, V4-complete or V5-complete claim before their gates.

## Operating discipline

One PR has one purpose. Clone-based agents read `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and run
`node scripts/agent-context.js`. Connector-only work records local bootstrap and
Graphify as unverified. Every delivery carries exact base/head, scope, tests,
CI, review, merge identity, non-claims and the next-agent envelope.
