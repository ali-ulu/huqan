# Current Operating Roadmap

**Live baseline:** `main` at
`62b2c04f9d0ad25147053014c12960799f42c5e2` (PR #225 HTTP Adapter-0 authorization merge; PR #198 remains the Mutation/Receipt Owner-0 implementation merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package,
default-closed endpoint-contract, bounded external-client trust-profile
materialization, a dedicated durable replay-reservation primitive and one
internal candidate-quarantine mutation/receipt owner. A thin internal HTTP
adapter contract is now authorized, but no adapter implementation, route or
production server composition exists. A test-only inline-enforcement matrix is
also present and does not alter the external-client gate order or create
reachability. HUQAN is not yet a fully inline trust control plane for every
client, connector, receipt family or mutation path.

## Reconciled sequence through HTTP Adapter-0 authorization

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132 | Production trust coverage matrix | Documentation and tests do not prove universal connector enforcement |
| #133 | Direct mutation ownership inventory | Inventory is not migration or transactionality |
| #134 | Durable mutation-journal ownership decision | Universal plugin journal migration remains deferred |
| #135 / #139 | GitHub source credential and fail-closed sourceRef redaction | Redaction does not authorize external ingest |
| #140-#151 | Immutable external-source resolution, reviewed approval, replay-safe execution and canonical receipt chain | No public external-source route or automatic approval policy |
| #153 / #154 | Signed external-client package gate and SDK admission boundary | No production endpoint or caller authority mapping |
| #156 / #157 | Trust-root boundaries and receipt schema evolution | Contracts only; no production V2 writer |
| #158 / #160 | Receipt trust-root test scope and fixture corpus | Structural fixtures do not enable V2 writes |
| #161 / #162 | Version-aware receipt foundation and runtime implementation | Global production V2 durable writes remain fail-closed |
| #164 / #165 | RTR-3A authorization and durable family-scoped SQLite lineage | Internal family metadata does not select or enable a production V2 writer |
| #167 / #168 | RTR-4 authorization and adversarial migration/compatibility proof | Test-only hardening does not select a production writer or change runtime ownership |
| #170 / #171 | RTR-5 authorization and exact-main closeout audit | Bounded foundation closes; production issuance and endpoint authority remain blocked |
| #173 / #174 | Endpoint-0 authorization and pure default-closed contract | Configuration may be requested, but no HTTP route, authority, mutation or writer is enabled |
| #175 / #178 / #177 | Authority-0 authorization, package-surface recovery and bounded implementation | In-process admission authority is enforced; no reachable route, HTTP identity extraction, concrete durable replay store, mutation or production receipt writer is enabled |
| #179 / #180 | Authority-0 checkpoint reconciliation and Adversarial-0 authorization | Documentation and authorization do not enable a route or alter runtime behavior |
| #181 / #182 | Adversarial-0 replay-result recovery authorization and bounded runtime recovery | Exact replay-result validation closes the discovered bypass without adding storage, mutation or writer ownership |
| #183 / #184 | Adversarial-0 test-only matrix and checkpoint reconciliation | Fail-closed boundaries are proven; no reachable endpoint, durable replay store or production effect is enabled |
| #185 / #186 | Enablement-0 use-case decision and staged authorization | Mandatory successor order is fixed; no runtime gate is collapsed or implemented |
| #187 / #188 | Identity/Trust Config-0 scope and trusted-key roster recovery | Contract only; no materializer, server loader, route, replay, mutation or receipt writer exists |
| #189 / #190 | Identity/Trust Config-0 checkpoint reconciliation and pure bounded materializer | Internal materialization exists; no server wiring, deployment source, durable replay, route, mutation, receipt or package exposure |
| #191 / #192 | Identity/Trust Config-0 implementation reconciliation and Durable Replay-0 authorization | Dedicated SQLite ownership contract is locked; no replay runtime, wiring, route, mutation or receipt effect exists |
| #193 / #194 | Durable Replay-0 authorization reconciliation and dedicated SQLite implementation | Durable replay exists as an internal owner; no Authority/server wiring, route, mutation, receipt or package exposure |
| #195 / #196 | Durable Replay post-merge reconciliation and Mutation/Receipt Owner-0 authorization | One candidate-quarantine mutation and exact V2 receipt policy are selected; no runtime owner, route, global V2 writer or package exposure exists |
| #197 / #198 | Mutation/Receipt Owner-0 authorization reconciliation and bounded implementation | Internal owner is real and exact-scope; no HTTP adapter, route, server composition, global V2 writer or package exposure exists |
| #223 | Test-only inline enforcement matrix for tool, memory and MCP gates | Adds fail-closed coverage only; it does not change the external-client authorization sequence, route reachability or runtime ownership |
| #202 / #225 | Mutation/Receipt Owner-0 post-merge reconciliation and HTTP Adapter-0 authorization | Thin transport contract is locked; no adapter runtime, route, server composition, deployment source or package exposure exists |

## Closed receipt trust-root foundation

RTR-3, RTR-3A, RTR-4 and RTR-5 establish:

- deterministic canonical V2 construction and exact validation;
- exactly `local_operator` and `external_verified_client` trust roots;
- version-aware materialized reads and export verification;
- historical V1 canonical payload, byte, hash, chain and bundle preservation;
- V1 to V2 chronology validation without predecessor rewrite or rehash;
- V2 to V1 downgrade, unsupported schema and invalid trust-root rejection;
- mixed-family V4 export refusal;
- a durable-write guard that rejects production V2 writes;
- bounded internal `receipt_family` metadata with exactly `v4` and `non-v4`;
- atomic legacy SQLite family backfill from stored canonical payloads;
- typed fail-closed migration integrity errors without silent JSON fallback;
- predecessor selection scoped by both workspace and derived family;
- adversarial real-SQLite migration, malformed-metadata, isolation, replay,
  rollback and continued-V2-refusal evidence;
- fail-closed materialized readers and V1/V2 export verification without partial
  evidence or input mutation;
- an exact-main source/test/CI closeout report with separate foundation and
  production-readiness verdicts;
- unchanged public committed-receipt shape.

The closed foundation still does **not** provide:

- a global authoritative production V2 trust-root writer;
- general durable production V2 receipt creation;
- historical V1 trust-root classification or backfill;
- a universal receipt-family or trust-root registry.

## Closed Endpoint-0 contract

Endpoint-0 now provides:

- immutable contract version `external-client-endpoint-0-v1`;
- reserved method and path `POST /api/external-client/packages/admit`;
- explicit configuration key `AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED`;
- exact `disabled | requested` configuration parsing;
- fail-closed `EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID` handling;
- inherited, accessor-backed and malformed configuration resistance;
- a frozen null-prototype descriptor;
- static proof that `server.js` has no route, contract import, package-gate
  import or `admitExternalPackage` call.

Endpoint-0 deliberately does **not** provide:

- a reachable or enabled external-client route;
- production client identity or authentication;
- authoritative workspace mapping;
- trusted-key loading, revocation or route-level package admission;
- freshness or replay enforcement at a reachable boundary;
- mutation, approval, audit or receipt effects;
- production V2 writer ownership.

A `requested` configuration state leaves every route, authority, freshness,
replay, mutation and writer-readiness bit false.

## Closed Authority-0 boundary

Authority-0 now provides an unreachable in-process admission boundary that:

- snapshots exact client identity, authoritative workspace scope, permissions
  and trusted-key authority;
- binds the reviewed signed-package bytes and expected trusted-key scope;
- enforces signed-package freshness against a trusted clock and trusted-key
  validity;
- requires atomic replay reservation before handler execution;
- keeps SDK package admission fail-closed when authority configuration is
  absent, malformed or incomplete;
- preserves thin SDK orchestration and adds no server route.

Authority-0 deliberately does **not** provide:

- a reachable external-client endpoint or HTTP identity extraction;
- production composition of the trust profile or replay owner;
- Graph, Kernel, memory, approval, audit or receipt mutation;
- production V2 receipt writing or trust-root ownership;
- public configuration rollout or external interoperability proof.

## Closed Adversarial-0 boundary

Adversarial-0 now proves:

- rejected package, identity, workspace, key-scope, key-validity and freshness
  cases do not reach replay reservation, admission handlers or Kernel fallback;
- exact key-validity and signed-package freshness boundaries remain inclusive,
  with one-millisecond freshness overruns rejected;
- hostile replay-owner results use bounded errors and cannot invoke downstream
  admission;
- two concurrent admissions for identical signed evidence produce exactly one
  allow and one replay rejection under the existing atomic-owner contract;
- replay evidence is deterministic, frozen, secret-free and limited to the
  existing Authority-0 fields;
- Endpoint-0 `requested` configuration does not infer package authority.

Adversarial-0 deliberately does **not** provide a reachable route, production
composition, Graph or Kernel mutation, approval, audit, receipt writing,
production V2 writer ownership or external interoperability.

## Closed Enablement-0 authorization sequence

Enablement-0 fixes the following mandatory order and forbids collapsing it:

1. Identity/Trust Config-0;
2. Durable Replay-0;
3. Mutation and Receipt Owner-0;
4. thin HTTP Adapter-0;
5. Route Adversarial-0;
6. Enablement-0 closeout audit.

The route remains absent until every required predecessor closes green. A
requested configuration value does not imply reachability, authority, replay
protection, mutation permission or receipt-writer readiness.

## Closed Identity/Trust Config-0 implementation

The merged materializer now provides:

- one exact internal profile version `external-client-trust-config-0-v1`;
- exact identity subject and kind, workspace, package and the single
  `package:admit` permission;
- exact 44-byte `Buffer` or `Uint8Array` Ed25519 public SPKI DER loading;
- defensive visible-byte copying and a frozen public Ed25519 `crypto.KeyObject`;
- exact singleton key scopes matching the profile root;
- canonical validity intervals and `revoked: false` only;
- one steady-state active key or exactly two old/new restart-rotation keys;
- fail-closed zero-key, three-or-more-key, malformed, inherited,
  accessor-backed, non-enumerable, symbol and Proxy-hostile input;
- immutable, deterministic and secret-free output without input aliasing;
- compatibility with the existing Authority-0 snapshot boundary;
- no environment, filesystem, network, system-clock or module-global mutable
  registry.

The implementation deliberately does **not** provide:

- a public configuration schema or deployment source;
- server composition, hot reload or a multi-client registry;
- trusted clock or durable replay ownership;
- a registered route, mutation or receipt writer;
- package allowlist or published npm exposure;
- a universal Authority-0 roster limit.

PR #190 passed the isolated `17/17` materializer matrix and the complete runtime
suite with `377/377` tests. Security Checks, benchmark and Docker jobs passed.
Two candidate defects were caught and corrected before merge: output fields
that violated Authority-0's exact trusted-key shape and a module-level mutable
error-classification registry.

## Closed Durable Replay-0 implementation

The merged replay owner now provides:

- one dedicated `external_client_replay_reservations` SQLite table and expiry
  index, isolated from Graph journal and MemoryStore domains;
- exact validation of the Authority-supplied replay record;
- trusted incoming `reservedAt` and `expiresAt` values with no system-time TTL;
- WAL mode, `synchronous = FULL`, foreign keys, bounded busy timeout and reuse
  of the existing bounded SQLite lock-retry helpers;
- one immediate write transaction before expired-row cleanup, same-key lookup
  and insertion;
- exact frozen `{ reserved: true }` and `{ reserved: false }` results with no
  existing-row evidence leak;
- inclusive expiry replacement when `existing.expiresAt <= incoming.reservedAt`;
- persistence across close and reopen;
- same-process and independent-process exactly-once reservation behavior;
- fail-closed rollback, lock exhaustion, incompatible schema, corrupt database,
  missing dependency and reserve-after-close behavior;
- bounded hostile-input and SQLite initialization failures before owner return;
- one frozen internal owner compatible with Authority-0's injected `reserve`
  contract; and
- no read, list, export or administrative replay API.

The implementation deliberately does **not** provide:

- Authority or server composition wiring;
- a deployment database path source;
- a reachable route or HTTP adapter;
- an admitted Graph/Kernel mutation;
- an approval, audit or receipt effect;
- production V2 receipt or trust-root writer ownership;
- package allowlist or published npm exposure;
- JSON, process-memory, remote-database or distributed-lock fallback.

PR #194 passed exact-head `npm test (runtime/test)`, Benchmark, Docker and
Security jobs. The connected CI surface did not expose the full-suite test
count, so this roadmap records only the observed successful jobs and does not
invent a number. A source-first review also caught and fixed raw SQLite
initialization-error escape before merge.

## Closed Mutation/Receipt Owner-0 implementation

The merged internal owner now provides:

- exactly one verified signed package containing exactly one pending candidate
  claim and no other embedded object collection;
- one local workspace-scoped candidate quarantine projection with a derived
  local ID, forced `pending` status, forced `flag` recommendation and no
  imported external conflict or review authority;
- no direct Graph node or edge mutation;
- deterministic operation and receipt IDs derived from the authoritative
  package, workspace and replay context;
- the existing SQLite `Graph.runMutationOnce()` boundary as the atomic owner of
  candidate persistence, canonical receipt and completed mutation journal;
- the operation ID
  `external-client-candidate-claim:<Authority-0 replayKey>`;
- a canonical `v4-receipt-v2` receipt with
  `trustRoot: external_verified_client`, `verdict: review`,
  `decision: review` and `status: pending`;
- trusted `createdAt` derived from Authority-0 `reservedAt`;
- one exact structural V2 write policy recognized by the existing published
  V4 guard while unrelated V2 writes remain fail-closed;
- one shared aggregate 10,000-value JSON budget within each complete package
  or authority snapshot traversal;
- fail-closed unknown-outcome behavior with no automatic retry, second replay
  reservation, compensation or success response; and
- an internal-only owner excluded from the npm package surface.

Source-first review found and closed a real bounded-input defect before merge:
the original numeric visit counter was copied across sibling recursion branches.
The final shared budget rejects a package containing 10,001 sibling values
before transaction entry and proves zero candidate, mutation-journal and
mutation-receipt rows.

The implementation deliberately does **not** provide:

- a reachable external-client route or HTTP adapter;
- server or SDK composition of trust config, durable replay and mutation owner;
- HTTP identity extraction or route-level authority enforcement;
- approval completion, direct canonical node/edge import or external conflict
  authority;
- a global production V2 switch, generic capability factory or public writer;
- package metadata, module export, dependency or release changes; or
- external interoperability evidence.

PR #198 merged as
`3eb5dfe4592188827b5f2627fce886b64ef55fc6` with exactly four authorized
files. Exact-head GitHub Actions recorded Security Checks run `30861285186`
as successful and Benchmark Regression workflow run `30861285269` as
successful. Its runtime job reported `2499` tests, `2470` passing, `0` failing
and `29` skipped across `224` suites. Benchmark and Docker workloads were
`NOT_APPLICABLE` for that run. A separate fresh lead run reported `2497`
tests, `2468` passing, `0` failing and `29` skipped; both green totals are
recorded rather than silently reconciled. Package dry-run boundary proof passed
inside the full runtime suite.

## Closed HTTP Adapter-0 authorization

The merged authorization fixes one internal transport boundary with:

- exact future implementation scope limited to
  `lib/external-client-http-adapter.js` and
  `lib/external-client-http-adapter.test.js`;
- the reserved `POST /api/external-client/packages/admit` method while route
  registration remains forbidden;
- a Node-compatible raw request stream and non-injectable `JSON.parse` decoder;
- exactly `package` and `signature` as caller-controlled envelope fields;
- a fixed `1_048_576` byte body limit, `5_000` millisecond read timeout, fatal
  UTF-8 decoding, depth `32` and one shared `10_000`-value aggregate budget;
- exactly one injected, pre-bound `admitPackage({ package, signature })` use case;
- no caller-controlled identity, workspace, permission, trusted key, trust root,
  clock, replay, mutation or receipt authority;
- no direct SDK, Authority, trust-config, replay-store, mutation-owner, Graph,
  Kernel, storage or server import;
- exact frozen response descriptors with secret-free success and failure bodies;
- `201` for a new synchronous quarantine, `200` for an exact journal replay and
  no `202`, pending queue or retry behavior;
- bounded status classification without exposing internal error codes, details,
  stack, package bytes, signatures, replay evidence or receipt payloads;
- generic API key and rate limiting retained only as future outer route guards;
- static route absence and npm package-surface exclusion requirements.

Source-first review corrected an invalid first-draft assumption: accessor,
Proxy, cycle and non-enumerable shapes are not representable after a fixed raw
JSON parser. The final contract instead forbids parser injection, rejects a
literal `__proto__` key and tests representable raw JSON depth and aggregate
value boundaries.

The authorization deliberately does **not** provide:

- adapter runtime code;
- route registration or socket response writing;
- server composition of trust profile, durable replay, SDK or mutation owner;
- a production configuration or database-path source;
- transport credentials as external-client identity or authority;
- public npm exposure, package, dependency, version, deployment or release
  changes;
- route adversarial proof, external interoperability or production reachability.

PR #225 merged as
`62b2c04f9d0ad25147053014c12960799f42c5e2` with exactly one task-pack.
Exact-head Security Checks run `30920069018` and Benchmark Regression run
`30920069028` completed successfully. Runtime, Benchmark workload and Docker
execution are not claimed for the docs-only authorization scope.

## Current authorization state

HTTP Adapter-0 authorization is merged at the exact baseline above. This
post-authorization reconciliation is docs-only and authorizes no adapter,
route, server composition or deployment source by itself.

After this reconciliation merges and canonical `main` is re-read, the only
next gate is:

```text
EXTERNAL_CLIENT_HTTP_ADAPTER_0_IMPLEMENTATION
```

The implementation scope is exactly:

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

No existing runtime file may change. The implementation may import only the
reserved endpoint method and existing transport-size constant required by the
authorization. It must not register a route or import SDK, Authority, trust
config, replay store, mutation owner, Graph, Kernel, storage or server modules.

## Remaining execution order

### 1. External Client HTTP Adapter-0 implementation

Implement and adversarially prove the authorized thin internal adapter only.
Required evidence includes exact method/media-type behavior, declared and
observed byte limits, read timeout, fatal UTF-8 parsing, exact envelope,
depth/value boundaries, frozen detached delegation input, exactly-once
invocation, bounded error mapping, no retry, static route absence and npm
package dry-run exclusion.

### 2. HTTP Adapter-0 post-merge reconciliation

Record exact source, targeted tests, full regression, CI, package dry-run and
post-merge evidence before opening route work.

### 3. External Client Route Adversarial-0

Prove default-closed absence, spoofing and malformed-input rejection, outer
authentication and rate-limit ordering, replay across restart and concurrency,
no-retry behavior and mutation/receipt evidence before any reachability claim.

### 4. External Client Enablement-0 closeout

Audit lineage, scopes, route behavior, CI, fail-closed boundaries and non-claims
before any completion statement.

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

- HTTP Adapter-0 implementation does not start before this exact-main
  authorization reconciliation closes.
- Adapter implementation remains exactly two files and may not register a route
  or change server composition.
- The adapter remains thin and may not reimplement identity, trust-profile,
  signature, workspace, freshness, replay, mutation or receipt ownership.
- Request data is limited to package and signature bytes; transport credentials
  and caller labels never establish external-client authority.
- The narrow exact external candidate V2 policy must not become a generic V2
  switch, capability factory or caller-controlled bypass.
- Route registration remains downstream and requires adapter implementation and
  its post-merge evidence to close first.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  actor labels, local reachability, signatures, replay durability or fixture
  values.
- Unknown or incomplete read, admission or mutation outcomes are never
  automatically retried or compensated.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in this reconciliation or Adapter-0
  implementation.
- No server composition wiring for trust config, replay, SDK or mutation owner.
- No deployment configuration or replay-database path source.
- No request-controlled identity, workspace, permission, trusted key, trust
  root, clock, replay state, mutation or receipt metadata.
- No direct node/edge import or external audit, receipt, approval or conflict
  authority import.
- No MemoryStore, JSON or process-memory replay or mutation persistence.
- No adapter-owned API-key store, rate-limit map, registry, queue, database,
  clock or handler registry.
- No `202 Accepted`, memory-only pending queue, automatic retry or compensation.
- No global production V2 switch, generic capability factory or public V2
  writer API.
- No package metadata, module export, dependency, version, deployment or release
  change.
- No historical receipt rewrite, rehash or trust-root backfill.
- No universal external-client registry or distributed-database claim.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
