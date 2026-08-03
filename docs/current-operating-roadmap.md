# Current Operating Roadmap

**Live baseline:** `main` at
`fe0a1a460f4ca9b55d948777c2eb0dab4b0a6dc2` (PR #192 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source, signed-package,
default-closed endpoint-contract and bounded external-client trust-profile
materialization primitives. It is not yet a fully inline trust control plane for
every client, connector, receipt family or mutation path.

## Reconciled sequence through Durable Replay-0 authorization

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
| #191 / #192 | Identity/Trust Config-0 implementation reconciliation and Durable Replay-0 authorization | Dedicated SQLite contract is locked; no replay runtime, wiring, route, mutation or receipt effect exists |

## Closed receipt trust-root foundation

RTR-3, RTR-3A, RTR-4 and RTR-5 establish deterministic V2 construction,
version-aware reads and export, historical V1 byte/hash preservation,
family-scoped SQLite lineage, adversarial migration proof and a production V2
write guard. The closed foundation still does **not** provide an authoritative
production V2 writer, durable production V2 issuance, historical V1 trust-root
backfill or a universal receipt-family registry.

## Closed Endpoint-0 contract

Endpoint-0 reserves `POST /api/external-client/packages/admit`, parses exact
`disabled | requested` configuration and proves `server.js` remains unaware of
the route. It deliberately provides no reachable endpoint, transport identity,
trusted-key loading, replay owner, mutation, receipt effect or V2 writer.

## Closed Authority-0 and Adversarial-0 boundary

Authority-0 snapshots exact client identity, workspace, permission and key
scope, verifies signed-package freshness against a trusted clock and requires an
atomic replay reservation before downstream handling. Adversarial-0 proves
fail-closed scope, time, side-effect, hostile replay-result and concurrent
duplicate boundaries. Neither gate provides a reachable route, concrete durable
replay store, mutation, receipt writer or external interoperability.

## Closed Enablement-0 authorization sequence

Enablement-0 fixes the following mandatory order and forbids collapsing it:

1. `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0`;
2. `EXTERNAL_CLIENT_DURABLE_REPLAY_0`;
3. `EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_0`;
4. `EXTERNAL_CLIENT_HTTP_ADAPTER_0`;
5. `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0`;
6. `EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT`.

The route remains absent until every predecessor closes green. Requested
configuration never implies reachability, authority, replay protection,
mutation permission or writer readiness.

## Closed Identity/Trust Config-0 implementation

The merged materializer provides:

- exact profile version, identity, workspace, package and `package:admit` scope;
- exact 44-byte Ed25519 public SPKI DER loading with visible-byte copying;
- frozen public KeyObjects and immutable secret-free output;
- exact singleton key scopes and canonical validity intervals;
- one steady-state key or exactly two restart-rotation keys;
- fail-closed malformed, hostile, zero-key and three-or-more-key input;
- compatibility with the existing Authority-0 snapshot boundary; and
- no environment, filesystem, network, clock or module-global mutable registry.

It deliberately provides no public configuration source, server composition,
durable replay owner, route, mutation, receipt writer or package export.

## Closed Durable Replay-0 authorization

The authorization selects one dedicated internal SQLite owner and binds:

- exact Authority-supplied replay records and trusted `reservedAt` / `expiresAt`;
- one dedicated `external_client_replay_reservations` table and expiry index;
- an immediate atomic write transaction before same-key inspection;
- exact frozen `{ reserved: true }` and `{ reserved: false }` results;
- expiry replacement at `existing.expiresAt <= incoming.reservedAt`;
- WAL, `synchronous = FULL`, bounded busy timeout and existing bounded
  `SQLITE_BUSY` / `SQLITE_LOCKED` retry helpers;
- restart, exact-expiry, same-process and cross-process concurrency evidence;
- incompatible-schema, corrupt-database, rollback and close-state refusal; and
- an exact two-file implementation scope.

The owner must not reuse Graph journal, MemoryStore, viewer sessions, JSON or
process memory. It reads no system time, returns no existing-row evidence and
adds no read/list/export API.

## Current authorization state

PR #192 merged the docs-only Durable Replay-0 authorization at the exact
baseline above. This reconciliation authorizes no runtime change by itself.
After it merges and canonical `main` is re-read, the only next gate is:

```text
EXTERNAL_CLIENT_DURABLE_REPLAY_0_IMPLEMENTATION
```

The exact implementation scope is:

```text
lib/external-client-replay-store.js
lib/external-client-replay-store.test.js
```

No existing runtime file may change. Authority, SDK, server, endpoint, Graph,
MemoryStore, mutation, receipt, package metadata and public schemas remain
closed.

## Remaining execution order

### 1. External Client Durable Replay-0 implementation

Implement and adversarially prove the dedicated SQLite atomic replay owner.
Required evidence includes persistence across reopen, trusted-time expiry,
one-process and cross-process exactly-once reservation, bounded lock retry,
rollback and incompatible-schema refusal.

### 2. Durable Replay-0 post-merge reconciliation

Record exact source, test and CI evidence before opening mutation and receipt
ownership.

### 3. External Client Mutation and Receipt Owner-0

Select the exact bounded admitted mutation, durable mutation owner and receipt
owner. Define unknown or incomplete outcome behavior without automatic retry.
Production V2 receipt writing remains disabled unless separately authorized.

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

- Durable Replay-0 implementation does not start before this exact-main
  authorization reconciliation closes.
- Mutation and receipt ownership do not start before Durable Replay-0
  implementation and post-merge evidence close.
- Mutation and receipt ownership precede any reachable HTTP adapter.
- Route registration remains last and requires every predecessor to close.
- Production V2 writer ownership is not inferred from endpoint, SDK, transport,
  actor labels, local reachability, signatures or fixture values.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No reachable external-client route in this reconciliation or replay gate.
- No process-memory or JSON replay fallback.
- No Graph journal or MemoryStore replay ownership.
- No mutation or receipt ownership inside Durable Replay-0.
- No production V2 writer or trust-root owner selection.
- No historical receipt rewrite, rehash or trust-root backfill.
- No caller-controlled replay table, TTL, cleanup policy, identity, workspace,
  permission, key roster, receipt family or trust root.
- No automatic retry after an unknown transaction outcome.
- No public replay read/list/export API.
- No universal external-client registry or distributed database claim.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.
- No release, deployment, package-version or dependency change.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
