# Current Operating Roadmap

**Live baseline:** `main` at
`4360c03c163fe4d8189ccb5d3c1c9845ce50b3f5` (PR #228 HTTP Adapter-0
implementation merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI or an exact merged SHA, live evidence
wins.

The roadmap is intentionally compact. Detailed history remains in Git, merged
PR evidence and task-packs rather than being repeated in every agent context.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package,
default-closed endpoint-contract, bounded external-client trust-profile
materialization, a dedicated durable replay-reservation primitive, one internal
candidate-quarantine mutation/receipt owner and one thin internal HTTP adapter.

The adapter is implemented but unreachable. No external-client route is
registered; no production server composition, deployment source, HTTP identity
mapping or public npm exposure exists. A requested endpoint configuration still
does not imply reachability or readiness. HUQAN is not yet a fully inline trust
control plane for every client, connector, receipt family or mutation path.

## Reconciled sequence through HTTP Adapter-0 implementation

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#151 | Coverage inventory, mutation ownership, immutable-source resolution, reviewed approval and canonical receipt chain | No universal connector enforcement or public external-source route |
| #153 / #154 | Signed external-client package gate and SDK admission boundary | No production endpoint or caller authority mapping |
| #156-#171 | Receipt trust-root ADR, fixtures, version-aware V2 foundation, family-scoped SQLite migration, compatibility matrix and closeout | No global production V2 writer or historical V1 rewrite |
| #173 / #174 | Endpoint-0 authorization and pure default-closed contract | Configuration may be requested, but no route, authority, mutation or writer is enabled |
| #175-#184 | Authority-0, replay-result recovery and adversarial authority matrix | In-process authority exists; no reachable route or production composition |
| #185 / #186 | Enablement-0 use-case decision and mandatory successor sequence | Successor gates may not be collapsed |
| #187-#192 | Identity/Trust Config-0 authorization, materializer and reconciliation | One internal profile exists; no server loader or deployment source |
| #193-#195 | Durable Replay-0 dedicated SQLite owner and reconciliation | Replay owner exists but remains unwired |
| #196-#198 | Mutation/Receipt Owner-0 authorization, reconciliation and implementation | One internal candidate quarantine and exact V2 receipt owner exists; no HTTP route |
| #223 | Test-only inline-enforcement matrix | Coverage only; no route or ownership change |
| #202 / #225 / #226 | Mutation owner reconciliation, HTTP Adapter-0 authorization and authorization reconciliation | Thin transport contract locked; no adapter runtime at that point |
| #228 | HTTP Adapter-0 implementation | Internal response-descriptor adapter only; no route, server composition, deployment source or npm exposure |

## Closed receipt trust-root foundation

RTR-3, RTR-3A, RTR-4 and RTR-5 establish:

- deterministic canonical V2 construction and exact validation;
- exactly `local_operator` and `external_verified_client` trust roots;
- version-aware materialized reads and export verification;
- historical V1 canonical payload, byte, hash, chain and bundle preservation;
- V1 to V2 chronology validation without predecessor rewrite or rehash;
- V2 to V1 downgrade, unsupported schema and invalid trust-root rejection;
- bounded internal `receipt_family` metadata with exactly `v4` and `non-v4`;
- atomic legacy SQLite family backfill from stored canonical payloads;
- predecessor selection scoped by workspace and derived family;
- adversarial real-SQLite migration, malformed-metadata, isolation, replay,
  rollback and continued-V2-refusal evidence;
- fail-closed readers and V1/V2 export verification; and
- an exact-main closeout with separate foundation and production-readiness
  verdicts.

The foundation still does **not** provide a global authoritative production V2
writer, general durable V2 issuance, historical V1 trust-root backfill or a
universal trust-root registry.

## Closed Endpoint-0 and Authority-0 boundaries

Endpoint-0 provides an immutable default-closed descriptor for
`POST /api/external-client/packages/admit`. Its configuration is exactly
`disabled | requested`; every reachability, authority, replay, mutation and
writer-readiness bit remains false.

Authority-0 provides an unreachable in-process boundary that snapshots client
identity, authoritative workspace, permission and trusted-key authority;
verifies signed-package scope and freshness against a trusted clock; requires
atomic replay reservation; and fails closed before handler execution.

The adversarial authority matrix proves exact time and key boundaries,
side-effect isolation, replay-result validation and one-allow/one-reject
concurrency behavior. None of these boundaries registers a route or performs
production server composition.

## Closed Identity/Trust Config-0 implementation

The internal materializer provides one exact server-owned client profile with:

- exact identity subject and kind, workspace, package and `package:admit` scope;
- bounded Ed25519 public-key loading, rotation and revocation state;
- immutable deterministic secret-free output without input aliasing;
- fail-closed malformed, inherited, accessor-backed, non-enumerable, symbol and
  Proxy-hostile input handling; and
- compatibility with Authority-0.

It deliberately does not read environment, filesystem or network state and does
not provide a public deployment schema, hot reload, multi-client registry,
trusted clock, replay owner, route or npm exposure.

## Closed Durable Replay-0 implementation

The dedicated SQLite owner provides:

- one isolated external-client replay-reservation table and expiry index;
- trusted incoming reservation times without a system-time TTL;
- an immediate write transaction with bounded lock retry;
- exact secret-free `{ reserved: true | false }` results;
- inclusive expiry replacement;
- restart, same-process, independent-process and concurrency evidence; and
- fail-closed rollback, lock exhaustion, schema, corruption, dependency and
  reserve-after-close behavior.

It remains unwired to Authority or server composition and provides no JSON,
process-memory, remote-database or distributed-lock fallback.

## Closed Mutation/Receipt Owner-0 implementation

The internal owner provides:

- exactly one verified pending candidate claim and no other embedded object;
- a local workspace-scoped quarantine projection with derived ID, forced
  `pending` status, forced `flag` recommendation and no imported review or
  conflict authority;
- no direct node or edge mutation;
- deterministic operation and receipt IDs;
- `Graph.runMutationOnce()` as the atomic owner of candidate persistence,
  canonical receipt and completed mutation journal;
- a canonical `v4-receipt-v2` receipt with
  `trustRoot: external_verified_client` and review/pending semantics;
- one shared 10,000-value aggregate JSON budget within each complete package or
  authority snapshot traversal;
- fail-closed unknown-outcome behavior without retry or compensation; and
- internal-only ownership outside the npm package surface.

PR #198 merged as
`3eb5dfe4592188827b5f2627fce886b64ef55fc6`. GitHub Actions recorded Security
Checks `30861285186` and Benchmark Regression `30861285269` successful. The
runtime job reported `2499` tests, `2470` passing, `0` failing and `29` skipped;
a separate fresh lead run reported `2497` tests, `2468` passing, `0` failing and
`29` skipped. Both green totals remain recorded rather than silently reconciled.

## Closed HTTP Adapter-0 implementation

PR #228 merged as
`4360c03c163fe4d8189ccb5d3c1c9845ce50b3f5` with exactly:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

The implementation provides one frozen internal adapter with:

- version `external-client-http-adapter-0-v1`;
- exact `POST` method and exact JSON media-type enforcement;
- fixed `1_048_576` observed/declared byte limit;
- fixed `5_000` millisecond stream-read timeout;
- fatal UTF-8 decoding and non-injectable `JSON.parse`;
- exact `{ package, signature }` request authority;
- rejection of unknown authority/control fields and literal `__proto__` keys;
- iterative depth `32` and one shared aggregate `10_000`-value request budget;
- a detached deeply frozen delegation snapshot;
- exactly one injected pre-bound `admitPackage` call;
- strict validation of the existing frozen SDK/admission result;
- frozen secret-free `201` descriptors for a new quarantine and `200`
  descriptors for an exact mutation-journal replay;
- bounded known-error classification without exposing codes, messages, details,
  stacks, package bytes, signature, authority, replay or receipt evidence;
- `503` for unknown dependency outcomes with no automatic retry, compensation,
  second reservation or pending queue;
- no `202 Accepted`; and
- imports limited to the reserved endpoint method and existing upload-size
  constant.

Source-first review found that a hostile Node-compatible request object could
present one normalized header value and a conflicting `rawHeaders` value. The
exact merged head rejects conflicting normalized/raw `content-type` and
`content-length` representations fail-closed and includes adversarial coverage.

Exact-head evidence:

- head `7116ee79dfe8ba13a7af50f4e665cd367985b8ea`;
- adapter blob `eb140e8577fc19a4f86538bc39eda06efed96db4`;
- test blob `871ab88d9fddf85b00157be50e377ef32ae7b878`;
- exact two-file diff, `+599 / -0`, 299/300 lines;
- Security Checks `30927539033`: `SUCCESS`;
- Benchmark Regression `30927539194`: `SUCCESS`;
- rerun runtime/full-suite job `92054400176`: `SUCCESS`;
- Benchmark and Docker workloads: `NOT_APPLICABLE`;
- unresolved inline review threads: `0`;
- source-first review `4856739545`: `PASS_CANDIDATE`;
- final Lead review `4858153640`: `[PASS]` under the transparently labeled
  PR #225/#226 single-operator continuity precedent.

The first runtime attempt failed during `npm ci` on a `node-gyp` network timeout
before tests. Only the failed job was rerun; installation and the full-suite
step then completed successfully. The connector did not return the successful
rerun's exact test total, so no current-head count is invented.

HTTP Adapter-0 deliberately does **not** provide:

- route registration, socket response writing or production reachability;
- server composition of trust profile, trusted clock, durable replay, SDK or
  mutation owner;
- a deployment configuration or replay-database path source;
- transport credentials as identity, workspace, permission or trust authority;
- route-level API-key and rate-limit ordering proof;
- public npm exposure, dependency, package version, deployment or release
  changes; or
- Route Adversarial-0, Enablement closeout, V4 or V5 completion.

## Current reconciliation state

HTTP Adapter-0 implementation is merged at the exact baseline above. This
post-merge reconciliation changes only the mutable checkpoint and this operating
roadmap. It authorizes no route, server composition, deployment source or public
package surface.

The expected next task-pack path:

```text
docs/task-packs/external-client-route-adversarial-0-authorization.md
```

is absent at the reconciled baseline. Therefore the only next gate is:

```text
EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_AUTHORIZATION
```

That gate must start from the exact post-reconciliation canonical `main`, define
its own narrow file scope and preserve the route as unregistered. It must not be
collapsed into implementation.

## Remaining execution order

### 1. HTTP Adapter-0 post-merge reconciliation

Record exact source, CI, review, package-boundary, static route-absence and
post-merge canonical-main evidence. Merge only the checkpoint and roadmap.

### 2. External Client Route Adversarial-0 authorization

Create one docs-only exact-base task-pack that defines:

- default-closed route absence and future registration boundary;
- outer generic API-key and rate-limit ordering without treating either as
  external-client authority;
- authoritative server-owned identity, workspace, trusted-key, clock, replay,
  SDK and mutation-owner composition requirements;
- malformed, oversized, invalid UTF-8, duplicate/conflicting header,
  prototype-pollution and spoofed-authority rejection;
- replay across restart, concurrency and exact journal-result behavior;
- handler failure and unknown-outcome no-retry behavior;
- exact mutation, journal and receipt evidence;
- independent external-client smoke boundaries; and
- exact non-claims before any reachability statement.

Authorization itself must not register a route or change runtime behavior.

### 3. External Client Route Adversarial-0 implementation and proof

Implement only the separately authorized scope. Prove all route, composition,
replay, mutation and receipt ordering boundaries before describing the endpoint
as reachable or production-ready.

### 4. External Client Enablement-0 closeout

Audit lineage, exact scopes, live route behavior, CI, fail-closed boundaries,
package surface and non-claims before recording bounded closeout.

### 5. V4 open items

1. Workbench runtime evidence;
2. bounded approval/action surface;
3. receipt inspection and export/import user-flow smoke;
4. V4 source/test/CI/release closeout.

### 6. V5 ecosystem items

1. bounded A2A exchange;
2. external conformance runner;
3. one real external-client integration;
4. GitHub App beta before Streaming Trust;
5. Certified Node and TrustBench drafts without public-launch or truth claims.

## Permanent ordering rules

- Every successor starts from an exact post-merge canonical `main` and receives
  its own authorization, narrow scope, implementation evidence, review and
  reconciliation.
- Route work does not begin before HTTP Adapter-0 implementation reconciliation
  closes.
- Route authorization is docs-only and may not register the route.
- Request data remains limited to package and signature bytes; transport
  credentials and caller labels never establish external-client authority.
- Identity, workspace, permission, trusted keys, clock, freshness, replay,
  mutation and receipt ownership remain server-owned.
- Generic API-key and rate limiting are outer transport-access guards only.
- The narrow external candidate V2 policy must not become a generic V2 switch,
  capability factory or caller-controlled bypass.
- Unknown or incomplete read, authority, replay, admission, mutation or receipt
  outcomes are never automatically retried or compensated.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  signatures, replay durability, actor labels or local reachability.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in this reconciliation or route
authorization.
- No server composition wiring before a separately authorized route task.
- No deployment configuration or replay-database path source.
- No request-controlled identity, workspace, permission, trusted key, trust
  root, clock, replay state, mutation or receipt metadata.
- No direct node/edge import or imported review, audit, receipt, approval or
  conflict authority.
- No MemoryStore, JSON or process-memory replay or mutation persistence.
- No adapter-owned API-key store, rate-limit map, registry, queue, database,
  clock or handler registry.
- No `202 Accepted`, memory-only pending queue, automatic retry or compensation.
- No global production V2 switch, generic capability factory or public V2
  writer API.
- No public npm export, dependency, package version, deployment or release
  change.
- No historical receipt rewrite, rehash or trust-root backfill.
- No universal external-client registry or distributed-database claim.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.

## Operating discipline

One PR has one purpose. Every non-trivial clone-based task starts from
`AGENTS.md`, `docs/agent-canon.md`, the mutable checkpoint and
`node scripts/agent-context.js`. Each runtime PR carries exact base/head,
targeted tests, full-regression and CI evidence when applicable, scope evidence,
worktree status and a two-minute eye test. Connector-only work records local
bootstrap and Graphify as unverified rather than inventing evidence. Update this
file only when exact source evidence changes execution order.
