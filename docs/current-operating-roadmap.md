# Current Operating Roadmap

**Live baseline:** `main` at
`2085c674b308b47a7ed1ee7956654f7c6556e3c0` (PR #188 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package and
default-closed endpoint-contract primitives. It is not yet a fully inline trust
control plane for every client, connector, receipt family or mutation path.

## Reconciled sequence through Identity/Trust Config-0 authorization

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
- freshness or replay enforcement;
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
- a concrete durable replay-store implementation;
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

Adversarial-0 deliberately does **not** provide a reachable route, concrete
durable replay store, distributed locking, Graph or Kernel mutation, approval,
audit, receipt writing, production V2 writer ownership or external
interoperability.

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

## Closed Identity/Trust Config-0 contract

The merged contract and roster recovery define the first configuration
materializer as:

- one exact, internal, explicitly injected server-composition profile;
- exact profile version `external-client-trust-config-0-v1`;
- exact identity subject and kind, workspace, package and the single
  `package:admit` permission;
- Ed25519 public SPKI DER key material copied from exact visible bytes;
- exact singleton key scopes matching the profile root;
- canonical validity intervals and `revoked: false` only;
- one steady-state active key or exactly two old/new restart-rotation keys;
- fail-closed zero-key, three-or-more-key, malformed, inherited,
  accessor-backed, non-enumerable, symbol and Proxy-hostile rosters;
- immutable, deterministic and secret-free output without input aliasing;
- no environment, filesystem, network, system-clock or global mutable state.

The contract deliberately does **not** provide:

- the runtime materializer itself;
- a public configuration schema or deployment source;
- server wiring, hot reload or a multi-client registry;
- Authority-0 construction, trusted clock or replay ownership;
- a route, mutation, receipt writer or package export surface;
- a universal Authority-0 roster limit.

## Current authorization state

PR #187 merged the docs-only Identity/Trust Config-0 scope. PR #188 then closed
the discovered trusted-key roster cardinality gap at the exact live baseline
above. Exact-head Security Checks and the docs-only change classifier passed;
runtime tests, benchmark execution and Docker build were correctly classified
as not applicable.

This checkpoint reconciliation is docs-only. It authorizes no runtime change.
After it merges and canonical `main` is re-read, the only next gate is the
exact-base `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0_IMPLEMENTATION` limited to:

```text
lib/external-client-trust-config.js
lib/external-client-trust-config.test.js
```

That implementation must remain a pure bounded materializer and must not change
Authority-0, SDK, server, endpoint, replay, mutation, receipt, package metadata,
dependencies or public schemas.

## Remaining execution order

### 1. Identity/Trust Config-0 implementation

Implement and adversarially test the pure internal profile materializer within
the exact two-file scope above. No server composition or public configuration
source is included.

### 2. External Client Durable Replay-0

Implement a SQLite-backed atomic replay-reservation owner and prove restart,
expiry, concurrency and cross-process behavior without registering the route.

### 3. External Client Mutation and Receipt Owner-0

Select the exact bounded mutation, durable owner, receipt owner and unknown
outcome behavior. Production V2 writing remains disabled unless separately
authorized.

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

- Identity/Trust Config-0 implementation does not start before this exact-main
  checkpoint reconciliation closes.
- Durable Replay-0 does not start before Identity/Trust Config-0 implementation
  and closeout evidence are green.
- Mutation and receipt ownership precede any reachable HTTP adapter.
- Route registration remains last and requires every predecessor to close.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  actor labels, local reachability, signatures or fixture values.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in this reconciliation or Identity/Trust
  Config-0 implementation.
- No environment, file or network configuration loader in the first
  materializer.
- No durable external-client replay owner before Durable Replay-0.
- No production V2 writer or trust-root owner selection.
- No historical receipt rewrite, rehash or trust-root backfill.
- No caller-controlled receipt-family, trust-root, identity, workspace,
  permission or key-roster metadata.
- No permissive fallback for receipt migration, external-source or
  external-client admission.
- No automatic retry when a mutation outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No universal receipt-family, trust-root or external-client registry.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.
- No release, deployment, package-version or dependency change.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
