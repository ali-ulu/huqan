# Current Operating Roadmap

**Live baseline:** `main` at
`79e6ebddbcd5c676217a54cd8a4157d83fd4363b` (PR #162 merge).

This is the execution-order source for current runtime work. It is not a
release claim and it does not replace architecture ADRs. When this file
conflicts with live source, tests, CI, or an exact merged SHA, the live evidence
wins.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, approval, audit, receipt, immutable-source and signed-package
primitives. It is not yet a fully inline trust control plane for every client,
connector, receipt family, or mutation path.

## Reconciled sequence through RTR-3

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132 | Production trust coverage matrix | Documentation and tests do not prove universal connector enforcement |
| #133 | Direct mutation ownership inventory | Inventory is not migration or transactionality |
| #134 | Durable mutation-journal ownership decision | Universal plugin journal migration remains deferred |
| #135 / #139 | GitHub source credential and fail-closed sourceRef redaction | Redaction does not authorize external ingest |
| #140-#151 | Immutable external-source resolution, reviewed approval, replay-safe execution and canonical receipt chain | No public external-source route or automatic approval policy |
| #153 / #154 | Signed external-client package gate and SDK admission boundary | No default-open production endpoint or caller authority mapping |
| #157 | Receipt trust-root schema evolution ADR | Contract only; no writer |
| #158 / #160 | Receipt trust-root test scope and fixture corpus | Structural fixtures do not enable V2 writes |
| #161 / #162 | Version-aware receipt foundation and runtime implementation | Production V2 durable writes remain fail-closed |

## Current receipt boundary

RTR-3 provides:

- deterministic canonical V2 construction and validation;
- explicit `local_operator` and `external_verified_client` trust roots;
- version-aware materialized reads and export verification;
- historical V1 byte/hash preservation;
- V1 to V2 chronology validation and V2 to V1 downgrade rejection;
- mixed-family V4 export refusal;
- a durable-write guard that rejects production V2 writes.

RTR-3 does **not** provide:

- family-scoped durable predecessor selection;
- a database migration for receipt-family lineage;
- authoritative production writer ownership;
- adversarial SQLite proof for V2 durable writes;
- a production external-client endpoint.

## Current authorization state

The checkpoint and this roadmap were stale at `11d1f8a3...` and are being
reconciled to the exact RTR-3 merge base above. This reconciliation is docs-only
and does not authorize runtime work.

After the reconciliation merges and canonical `main` is re-read, the only next
candidate is a **separate exact-base RTR-3A authorization task-pack**. That
task-pack may define scope, acceptance tests and forbidden files. RTR-3A runtime
implementation must not start before that authorization merges.

## Remaining execution order

### 1. RTR-3A — Durable family-scoped receipt chain

Required decisions and evidence:

1. family-scoped predecessor semantics;
2. database migration or explicit no-migration decision;
3. authoritative production writer ownership;
4. adversarial real-SQLite tests for insert, replay, rollback, conflict and
   cross-family isolation.

### 2. RTR-4 — Migration and compatibility hardening

Required evidence:

1. migration, chain, reader and export adversarial tests;
2. historical V1 bytes and hashes remain unchanged;
3. V1 to V2 transition works without predecessor rehash;
4. downgrade and unsupported-version paths fail closed.

### 3. RTR-5 — Receipt trust-root closeout audit

Required evidence:

1. source/test/CI audit over the complete receipt trust-root line;
2. every V2 production-writer claim is traced to an authoritative call path;
3. non-claims and remaining blockers are recorded against an exact main SHA.

### 4. External Client Endpoint-0

Define a default-closed endpoint contract and explicit opt-in configuration.
This gate does not add a reachable route or mutation path.

### 5. External Client Authority-0

Bind production endpoint admission to client identity, workspace, signed
package, trusted-key authority and bounded freshness/replay semantics. Existing
SDK/package primitives are foundations, not production endpoint proof.

### 6. External Client Adversarial-0

Prove fail-closed behavior for unsigned packages, wrong/revoked/expired keys,
replay, malformed input and mutation isolation.

### 7. External Client Enablement-0

Only after the preceding contracts and adversarial evidence pass:

1. add separate explicit enablement;
2. make the route reachable;
3. prove the production call chain from admission to mutation and receipt.

### 8. V4 open items

1. Workbench runtime evidence;
2. bounded approval/action surface;
3. receipt inspection and export/import user-flow smoke;
4. V4 source/test/CI/release closeout.

### 9. V5 ecosystem items

1. bounded A2A exchange;
2. external conformance runner;
3. one real external-client integration;
4. GitHub App beta before Streaming Trust;
5. Certified Node and TrustBench drafts without public-launch or truth claims.

## Permanent ordering rules

- RTR-4 does not start before RTR-3A closes.
- RTR-5 does not start before RTR-4 closes.
- External Client Enablement-0 does not start before endpoint, authority and
  adversarial gates close.
- V4 is not complete without real runtime and user-flow evidence.
- V5 implementation is not complete without V4 closeout and external
  interoperability evidence.
- Marketplace, badge and public reputation surfaces remain closed.

## Explicit non-goals

- No production V2 writer in checkpoint reconciliation or RTR-3A authorization.
- No historical receipt rewrite or backfill without a separately approved plan.
- No permissive fallback for external-source or external-client admission.
- No automatic retry when a mutation outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No V4-complete, V5-complete, universal-truth or universal-coverage claim.
- No release, deployment, package-version or dependency change.

## Operating discipline

One PR has one purpose. Every non-trivial task starts from `AGENTS.md`,
`docs/agent-canon.md`, the mutable checkpoint and `node scripts/agent-context.js`.
Each runtime PR must carry exact base/head, targeted tests, full-regression and
CI evidence when applicable, scope evidence, worktree status and a two-minute
eye test. Update this file only when exact source evidence changes the execution
order.
