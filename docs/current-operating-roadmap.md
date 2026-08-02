# Current Operating Roadmap

**Live baseline:** `main` at
`732573d110b73ca5014637a17b01a098dc210538` (PR #177 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package and
default-closed endpoint-contract primitives. It is not yet a fully inline trust
control plane for every client, connector, receipt family or mutation path.

## Reconciled sequence through Authority-0

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
- enforces fixed-time request and key freshness;
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

## Current authorization state

Authority-0 merged at the exact baseline above after its package-surface
recovery amendment. Exact-head Security Checks, runtime tests, package smoke,
Benchmark Regression and Docker build passed. Post-merge targeted and package
smoke evidence also passed. The production server remains unaware of the
reserved route and no mutation or receipt-writer owner changed.

This post-merge checkpoint reconciliation is docs-only. It does not authorize
adversarial implementation. After it merges and canonical `main` is re-read,
the only next candidate is a **separate exact-base External Client Adversarial-0
authorization task-pack**.

## Remaining execution order

### 1. External Client Adversarial-0

Prove fail-closed behavior for:

- unsigned or tampered packages;
- wrong, revoked or expired keys;
- identity and workspace mismatch;
- stale or replayed requests;
- malformed input and unknown fields;
- mutation, approval and receipt isolation before authorization succeeds.

### 2. External Client Enablement-0

Only after endpoint, authority and adversarial gates close:

1. add separate explicit enablement;
2. make the route reachable;
3. prove the production call chain from admission to mutation and receipt;
4. reconcile the selected trust-root writer and durable receipt behavior;
5. keep default configuration closed.

### 3. V4 open items

1. Workbench runtime evidence;
2. bounded approval/action surface;
3. receipt inspection and export/import user-flow smoke;
4. V4 source/test/CI/release closeout.

### 4. V5 ecosystem items

1. bounded A2A exchange;
2. external conformance runner;
3. one real external-client integration;
4. GitHub App beta before Streaming Trust;
5. Certified Node and TrustBench drafts without public-launch or truth claims.

## Permanent ordering rules

- External Client Adversarial-0 implementation does not start before its
  exact-base authorization closes.
- External Client Enablement-0 does not start before endpoint, authority and
  adversarial gates close.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  actor labels, local reachability, signatures or fixture values.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in reconciliation or Authority-0
  authorization.
- No production V2 writer or trust-root owner selection.
- No historical receipt rewrite, rehash or trust-root backfill.
- No caller-controlled receipt-family or trust-root metadata.
- No permissive fallback for receipt migration, external-source or
  external-client admission.
- No automatic retry when a mutation outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No universal receipt-family or trust-root registry.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.
- No release, deployment, package-version or dependency change.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
