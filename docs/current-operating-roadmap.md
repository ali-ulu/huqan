# Current Operating Roadmap

**Live baseline:** `main` at
`8b37716655a6516dfe834696f8f6793cc63ed78c` (PR #194 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package,
default-closed endpoint-contract, bounded external-client trust-profile
materialization and a dedicated durable replay-reservation primitive. It is not
yet a fully inline trust control plane for every client, connector, receipt
family or mutation path.

## Reconciled sequence through Durable Replay-0 implementation

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
| #161 / #162 | Version-aware receipt foundation and runtime implementation | Production V2 durable writes remain fail-closed |
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

- an authoritative production V2 trust-root writer;
- durable production V2 receipt creation;
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

## Current authorization state

Durable Replay-0 is merged at the exact baseline above. This post-implementation
reconciliation is docs-only and authorizes no mutation or receipt runtime
change.

After it merges and canonical `main` is re-read, the only next gate is a
separate exact-base docs-only authorization:

```text
EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_0_AUTHORIZATION
```

That authorization must inventory every live mutation and receipt path before
selecting any owner. It must distinguish admitted mutation authority, durable
transaction ownership, approval/audit effects, receipt schema/family/trust-root
selection, unknown-outcome behavior and compensation boundaries. No production
V2 writer, route or adapter may be inferred from replay completion.

## Remaining execution order

### 1. External Client Mutation and Receipt Owner-0 authorization

Create one exact-base task-pack that:

- inventories live Graph, Kernel, MemoryStore, approval, audit and receipt
  writers reachable from candidate external admission flows;
- selects or rejects one exact admitted mutation use case;
- identifies the authoritative durable transaction owner;
- identifies the exact receipt owner, schema version, family and trust-root
  policy without enabling production V2 writes implicitly;
- defines failure, unknown-outcome, compensation and no-retry behavior;
- locks exact implementation and adversarial test files; and
- preserves the absent HTTP route and package surface.

### 2. External Client Mutation and Receipt Owner-0 implementation

Implement only the separately authorized owner contract. Do not combine it with
HTTP transport or route registration.

### 3. Mutation/Receipt Owner-0 post-merge reconciliation

Record exact source, targeted test, full-regression, CI and post-merge evidence
before opening the HTTP adapter.

### 4. External Client HTTP Adapter-0

Add only a thin HTTP adapter after the preceding gates close. The adapter does
not own trust, replay, mutation or receipt semantics.

### 5. External Client Route Adversarial-0

Prove default-closed absence, spoofing and malformed-input rejection, replay
across restart and concurrency, no-retry behavior and mutation/receipt evidence.

### 6. External Client Enablement-0 closeout

Audit lineage, scopes, route behavior, CI, fail-closed boundaries and non-claims
before any completion statement.

### 7. V4 open items

1. Workbench runtime evidence;
2. bounded approval/action surface;
3. receipt inspection and export/import user-flow smoke;
4. V4 source/test/CI/release closeout.

### 8. V5 ecosystem items

1. bounded A2A exchange;
2. external conformance runner;
3. one real external-client integration;
4. GitHub App beta before Streaming Trust;
5. Certified Node and TrustBench drafts without public-launch or truth claims.

## Permanent ordering rules

- Mutation and Receipt Owner-0 implementation does not start before its
  exact-base authorization and Durable Replay-0 post-merge evidence close.
- Mutation and receipt ownership precede any reachable HTTP adapter.
- Route registration remains last and requires every predecessor to close.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  actor labels, local reachability, signatures, replay durability or fixture
  values.
- Unknown or incomplete mutation outcomes are never automatically retried.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in this reconciliation or owner
  authorization.
- No server composition wiring for trust config or replay in this
  reconciliation.
- No caller-controlled replay table, TTL, cleanup policy, identity, workspace,
  permission, key roster, receipt family or trust root.
- No mutation or receipt owner inferred from replay durability.
- No production V2 writer or trust-root owner selection without an explicit
  separately reviewed contract.
- No historical receipt rewrite, rehash or trust-root backfill.
- No automatic retry after an unknown transaction outcome.
- No public replay read/list/export API.
- No universal external-client registry or distributed-database claim.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.
- No release, deployment, package-version or dependency change.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
