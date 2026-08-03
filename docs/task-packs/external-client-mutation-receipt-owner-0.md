# EXTERNAL-CLIENT-MUTATION-RECEIPT-OWNER-0 — Exact-Base Authorization

## Gate Identity

- Repository: `ali-ulu/huqan`
- Mode: docs-only source-reality inventory and exact implementation authorization
- Exact authorization base: `main` at
  `cab001d6e0e008037aea78ec917dcfa173792b8b` (PR #195 merge)
- Closed predecessor: Durable Replay-0 implementation and post-merge
  reconciliation
- Authorized successor after this gate closes:
  `EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_0_IMPLEMENTATION`

This document authorizes no runtime behavior by itself. The implementation must
start from the exact post-merge `main` produced by this authorization PR.

## Source Reality at the Exact Base

1. `server.js` has no external-client admission route.
2. `lib/sdk.js` passes a verified package snapshot and Authority-0 context to an
   explicitly injected `packageAdmissionHandler`; the SDK does not own a
   domain mutation.
3. The signed package validator accepts ATP object collections including
   `candidateClaims`, `auditEvents`, `trustReceipts`, `verificationResults`,
   provenance and causal objects.
4. ATP candidate claims carry a caller-supplied ID, claim, proposed edge,
   provenance, conflict, recommendation, status, workspace and timestamps.
5. `Graph.addCandidateClaim()` already owns workspace-scoped candidate-claim
   persistence, but caller-selected candidate IDs use upsert semantics and
   therefore must not be admitted directly.
6. `Graph.runMutationOnce()` owns the existing SQLite mutation journal and can
   commit one domain mutation, one canonical receipt and the completed journal
   result in the same transaction.
7. `Graph.runMutationOnce()` restores Graph's mutable indexes when its SQLite
   transaction throws.
8. The current V4 durable-write guard permits V1 and non-V4 receipts but rejects
   V2-or-later V4 receipts with `V4_RECEIPT_V2_WRITE_NOT_ENABLED`.
9. Canonical V2 supports exactly the trust roots `local_operator` and
   `external_verified_client`; trust root is explicit and is never inferred
   from actor, transport, signature or package fields.
10. Existing approval receipts state `actionExecution: not_executed` and
    `actionOutcome: not_executed`; they are not proof of a committed candidate
    mutation.
11. Durable Replay-0 is an independent reservation owner. Replay reservation
    does not select a mutation, receipt writer or successful application
    outcome.

## Binding First Mutation Decision

The first external-client domain mutation is exactly:

```text
one verified signed package
→ exactly one embedded pending candidate claim
→ one local workspace-scoped pending candidate-claim quarantine record
→ no canonical Graph node or edge mutation
```

The package is rejected before transaction entry unless all of these are true:

- `objects.candidateClaims` contains exactly one item;
- every other embedded object collection is empty;
- the external candidate status is exactly `pending`;
- the external candidate is not canonical;
- candidate, proposed-edge and provenance workspace values equal the
  Authority-0 workspace;
- provenance actor equals the verified Authority-0 identity subject;
- provenance ID, claim and proposed edge are present and valid under the
  existing package/ATP validation;
- package ID, package hash, identity and replay key equal the Authority-0
  context passed by the SDK.

The implementation must not import external `auditEvents`, `trustReceipts`,
`verificationResults`, conflict conclusions, approval decisions or canonical
Graph objects as local authority.

## Local Candidate Projection

External fields are evidence, not local authority. The stored local candidate
must therefore:

- derive a new local candidate ID from the authoritative workspace, package
  hash and external candidate ID using canonical serialization plus SHA-256;
- never use the caller-supplied candidate ID as the local primary key;
- preserve the claim, proposed edge and provenance only after defensive
  snapshot and workspace validation;
- force `status: pending`;
- force `recommendation: flag`;
- clear `reviewedAt` and `reviewedBy`;
- not import the external conflict object as a local conflict conclusion;
- remain non-canonical and review-only.

The external candidate ID and a hash of the exact embedded candidate are
recorded in receipt metadata rather than used as local authority.

## Authoritative Transaction Owner

The transaction owner is the existing SQLite-backed:

```text
Graph.runMutationOnce(operationId, mutate, options)
```

The exact operation ID is:

```text
external-client-candidate-claim:<Authority-0 replayKey>
```

The mutation callback performs only the bounded local candidate projection and
`Graph.addCandidateClaim()` call. The transaction must atomically commit:

1. the local pending candidate record;
2. the canonical V2 receipt;
3. the completed mutation-journal result.

MemoryStore, JSON, process memory, the replay table, approval queue and a new
persistence owner are rejected.

## Exact Receipt Contract

The receipt owner is the same `Graph.runMutationOnce()` transaction. The
canonical receipt is V2 with:

```text
schemaVersion: v4-receipt-v2
trustRoot: external_verified_client
receiptKind: external_client_candidate_claim_admission
verdict: review
decision: review
status: pending
```

Required authority bindings:

- `admissionId` is the exact operation ID;
- `workspaceId` comes from Authority-0;
- `actor` and `agentId` come from the verified identity subject;
- `createdAt` is the ISO projection of Authority-0 `reservedAt`, never system
  time and never the caller's receipt timestamp;
- `provenanceId` is namespaced by package hash and the signed external
  provenance ID;
- `trustPolicyVersion` is the fixed internal owner policy version
  `external-client-mutation-receipt-owner-0-v1`;
- receipt ID is deterministically derived from the operation ID;
- metadata is exact, bounded and contains only mutation kind, operation ID,
  package ID/hash, replay key, trusted key ID, external/local candidate IDs and
  the embedded-candidate hash;
- no signature bytes, public keys, raw package, claim body, conflict body,
  receipt chain contents or private authority snapshot are copied into receipt
  metadata.

A V1 receipt is forbidden because it cannot express
`external_verified_client`. An approval receipt is forbidden because it proves
review state, not committed mutation.

## Narrow V2 Durable-Write Authorization

Global V2 production writing remains closed. The implementation may add one
internal, unexported capability that authorizes only the receipt contract above.

The capability must:

- be created only after exact package, authority, candidate and receipt
  validation;
- be bound to the exact operation ID, receipt ID, workspace, package hash,
  receipt kind, V2 schema and `external_verified_client` trust root;
- use a private immutable marker rather than a mutable global registry;
- be consumed by the existing V4 durable-write guard immediately before chain
  append/database insertion;
- fail closed when absent, copied, malformed, mismatched or reused for another
  payload;
- remain outside the npm package files list and public API.

All other V2-or-later V4 writes must continue to fail with
`V4_RECEIPT_V2_WRITE_NOT_ENABLED`.

## Failure and Unknown-Outcome Contract

Before transaction entry, validation failures are bounded rejection errors and
must cause no candidate, receipt or journal write.

After transaction entry, any thrown result for which a committed journal and
matching receipt cannot be proven is classified as:

```text
EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN
```

Unknown outcome behavior is binding:

- no automatic retry;
- no second replay reservation;
- no compensating delete or overwrite;
- no success response;
- return only the operation ID and bounded reconciliation requirement;
- do not expose SQLite text, package contents, keys or internal row data.

A transaction that is proven rolled back may return a bounded failure, but it
must still not retry automatically. A previously committed exact journal result
may be returned only after the operation ID, local candidate projection and
receipt bindings are all revalidated.

## Exact Implementation Scope

Only these files are authorized:

```text
lib/external-client-mutation-receipt-owner.js
lib/external-client-mutation-receipt-owner.test.js
lib/external-client-v2-write-authorization.js
lib/receipt/v4-receipt-family.js
graph.js
```

`graph.js` may receive only minimal capability pass-through at the existing
receipt-guard call. It must not receive package, identity, candidate, receipt
construction or error-mapping business logic.

The new owner remains internal and must not be added to `package.json` files,
SDK exports or any public entry point.

## Required Adversarial Evidence

The implementation test owner must prove at least:

1. exact one-candidate happy path;
2. Authority workspace, identity, package hash, replay key and trusted-key
   binding;
3. deterministic local candidate, operation and receipt IDs;
4. exact pending/flag/non-canonical local projection;
5. atomic candidate + receipt + journal commit;
6. restart persistence and exact committed-result readback;
7. caller candidate-ID collision cannot overwrite an existing local candidate;
8. duplicate journal operation performs no second mutation;
9. zero or multiple candidate claims reject before mutation;
10. every non-candidate object collection must be empty;
11. accepted/rejected/canonical external candidates reject;
12. workspace, provenance actor and proposed-edge scope mismatch reject;
13. external conflict, audit, receipt and recommendation authority are not
    imported;
14. V2 receipt has exact `external_verified_client` bindings;
15. capability absence, copying, shape mutation and payload mismatch reject;
16. unrelated V2 durable writes still return
    `V4_RECEIPT_V2_WRITE_NOT_ENABLED`;
17. V1 and historical chain behavior remain byte/hash compatible;
18. forced transaction rollback leaves no candidate, receipt or journal row;
19. post-entry failures produce bounded unknown outcome and no automatic retry;
20. hostile inherited, accessor, symbol, Proxy and mutation-after-call inputs
    fail closed;
21. no server route, SDK export, package file, deployment or dependency change.

Targeted tests, full `npm test`, Security Checks, Benchmark and Docker evidence
are mandatory on the exact reviewed head.

## Stop Conditions

Stop rather than widen scope if implementation requires:

- direct node/edge import;
- more than one candidate claim per package;
- importing external audit, receipt, approval or conflict objects as local
  authority;
- caller-controlled local candidate, operation or receipt IDs;
- MemoryStore, JSON or process-memory persistence;
- a second mutation or receipt transaction;
- a public V2 writer switch or generic caller-supplied bypass flag;
- a mutable global capability registry;
- package metadata or public API changes;
- server, HTTP adapter, route, SDK composition or deployment changes;
- automatic retry or compensation after unknown outcome;
- historical V1 rewrite, rehash or trust-root backfill;
- dependency, version, release or schema migration work.

## Acceptance Criteria for This Authorization Gate

This docs gate closes only when:

1. the changed file is exactly this task-pack;
2. exact base and predecessor evidence are correct;
3. source inventory distinguishes package evidence, mutation authority,
   transaction ownership and receipt ownership;
4. the one-candidate quarantine decision and rejected alternatives are explicit;
5. the narrow V2 capability cannot be interpreted as global V2 enablement;
6. unknown-outcome and no-retry semantics are explicit;
7. implementation and test files are exact;
8. `git diff --check` and repository-required CI pass;
9. source-first falsification review passes on the exact head;
10. merge uses the exact reviewed head and Notion records the evidence.

## Non-Claims

This authorization does not provide or enable:

- any runtime mutation or receipt write;
- a reachable external-client route or HTTP adapter;
- production server composition of trust config, replay or owner modules;
- direct Graph node/edge import;
- approval completion or canonical claim acceptance;
- global production V2 receipt writing;
- public package or SDK exposure;
- external interoperability, multi-client or multi-instance proof;
- V4 Workbench completion or V5 ecosystem completion;
- deployment, release, dependency or package-version changes.
