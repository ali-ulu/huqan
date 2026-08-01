# RECEIPT-TRUST-ROOT-1 - Contract Test Scope

## Plan Check

- Repository: `ali-ulu/huqan`
- Scope base: `main @ d49be1584ed8a0718a351bdb191691baafc1cea3`
- Predecessors: `ADR-008`, `ADR-009`
- Mode: docs-only test-scope definition
- Runtime implementation: not authorized
- Successor: `RECEIPT-TRUST-ROOT-2`

This task-pack defines executable characterization and contract-test ownership
for V4 receipt trust-root schema evolution. It does not change a receipt
writer, reader, chain, bundle, Graph journal, endpoint, or connector.

## Source Boundaries

The successor tests must keep these surfaces distinct:

| Surface | Current responsibility | Contract boundary |
| --- | --- | --- |
| `lib/receipt/canonical-receipt.js` | Builds and hashes canonical V4 v1 payloads | Preserve v1 exactly; future v2 shape is tested separately |
| `lib/receipt/receipt-chain.js` | Generic record hash/link validation | Do not turn it into a V4-only schema dispatcher |
| `lib/receipt/receipt-read-index.js` | Projects raw materialized admission receipts to V4 v1 on read | Lock legacy behavior and future explicit v2 discrimination |
| `lib/receipt/receipt-export.js` | Exports and verifies V4 bundle v1 envelopes | Lock historical v1 output; specify future v2 envelope cases |
| Graph mutation journal | Persists multiple receipt families through shared hash/link storage | Non-V4 families remain outside V4 schema validation |
| reviewed-external graph receipt | Separate exact receipt family and validator | Must not be reclassified or rewritten as V4 v1/v2 |

Persisted Graph receipt chains and the read index's reconstructed materialized
chain are different evidence surfaces. Tests must not assert that their hashes
or storage identities are interchangeable.

## Test Ownership

The successor fixture/test gate may add exactly:

```text
test/fixtures/receipt-trust-root/*.json
test/receipt-trust-root-contract.test.js
```

Existing tests are read-only regression owners:

```text
test/v4-trust-receipt-primitive.test.js
test/v4-receipt-materialization-read-index.test.js
test/durable-mutation-journal.test.js
test/reviewed-external-graph-execution.test.js
```

If an executable contract cannot remain green without runtime changes, stop.
Runtime seam-existence tests that require methods or versions not yet present
belong to `RECEIPT-TRUST-ROOT-3`, alongside the implementation that makes them
green. Deliberately red tests are forbidden.

## Fixture Format

Each fixture is self-contained deterministic JSON with:

```text
caseId
description
input
expected
nonClaims
```

Rules:

- fixture IDs and filenames are unique;
- timestamps and identifiers are fixed synthetic values;
- lowercase hex is used for hashes;
- no secret, private-key, credential, token, network, or provider material;
- no fixture claims runtime support before implementation;
- expected error/status values must come from existing vocabulary unless a
  later implementation contract explicitly approves a new bounded result;
- JSON descriptors are fixture data only and are never passed to runtime as
  an invented public API.

## Required Contract Matrix

### Historical V1 Preservation

1. Existing canonical v1 payload serializes byte-for-byte as the current
   golden value.
2. Existing v1 payload hash remains unchanged.
3. Existing v1 chained record and successor linkage remain unchanged.
4. Existing v1-only bundle bytes and bundle hash remain unchanged when fixed
   export time is supplied.
5. A discriminator-free raw materialized receipt follows the unchanged v1
   projection and receives no canonical `trustRoot` field.
6. `legacy_v1_unspecified` may appear only as non-canonical presentation
   expectation; it is never serialized or treated as local authority.

### V2 Shape

7. `local_operator` is a valid v2 trust root.
8. `external_verified_client` is a valid v2 trust root.
9. Missing `trustRoot` is invalid for declared v2.
10. Empty, whitespace, case-variant, numeric, object, array, and unknown trust
    roots are invalid.
11. Trust root nested in metadata does not satisfy the top-level requirement.
12. Unknown top-level fields remain fail-closed if the future v2 shape is
    exact/allowlisted.
13. A raw v2 receipt must declare
    `canonicalReceiptSchemaVersion: v4-receipt-v2` and a valid top-level
    `trustRoot`.
14. A raw receipt declaring v2 without a valid trust root is invalid and is
    never interpreted as v1.
15. An unknown raw discriminator is invalid rather than downgraded.

### V4 Chain Transition

16. A v1-only V4 chain remains valid and unchanged.
17. A chronological V4 `v1 -> v2(local_operator) -> v2(external_verified_client)`
    chain validates when every stored hash/link is exact.
18. V1-to-v2 transition changes only newly appended records; predecessors are
    not rehashed.
19. Reordered, inserted, removed, downgraded, or rewritten records fail.
20. A v2 record with an unsupported schema or invalid trust root fails V4
    family validation even when its generic content hash is internally valid.
21. Generic shared-journal validation remains capable of validating the
    existing non-V4 reviewed-external family.
22. V4 family validation does not absorb or relabel non-V4 records.

### Read and Export

23. V1 reads return historical canonical content without a fabricated trust
    root.
24. V2 reads preserve the exact committed trust root.
25. Read operations do not mutate raw or canonical input objects.
26. Unsupported or malformed declared versions return bounded invalid results.
27. Existing v1-only exports remain bundle v1.
28. A V4 export containing any v2 record uses bundle v2.
29. Bundle v2 verification validates the outer version, every V4 receipt
    version, receipt-array hash, and chain linkage.
30. Bundle version mismatch, invalid trust root, array tampering, record
    reordering, and historical v1 rewriting fail closed.
31. Existing exported artifacts are never regenerated or modified by tests.
32. Cross-family global journal export remains out of scope.

### Determinism and Immutability

33. Same bounded input, fixed time, previous hash, version, and trust root
    produce identical canonical bytes and hashes.
34. Input mutation after build cannot change a returned canonical payload or
    chained record.
35. Reader and exporter outputs are defensive copies where the current public
    contract requires copies.

## Required Test Commands

The successor fixture/test gate must run:

```text
node --test test/receipt-trust-root-contract.test.js

node --test --test-concurrency=1 \
  test/receipt-trust-root-contract.test.js \
  test/v4-trust-receipt-primitive.test.js \
  test/v4-receipt-materialization-read-index.test.js \
  test/durable-mutation-journal.test.js \
  test/reviewed-external-graph-execution.test.js

npm test
git diff --check
git status --short
```

The first successor may test only behavior executable on the current runtime.
Cases requiring v2 implementation must remain deterministic fixtures with
structural assertions, not runtime calls, until `RECEIPT-TRUST-ROOT-3`.

## Acceptance Criteria

- exact fixture/test ownership is named;
- the 35-case matrix is represented without duplicate case IDs;
- v1 golden bytes and hashes are captured from canonical source before any v2
  implementation;
- future v2 expectations match ADR-009 without pretending they run today;
- persisted Graph journal and reconstructed read-index chains remain distinct;
- existing non-V4 receipt-family tests remain green;
- targeted and full regression results are reported separately;
- no dependency, package, workflow, endpoint, connector, or runtime change;
- no production enforcement or legacy-backfill claim.

## Stop Conditions

Stop with `RECEIPT_TRUST_ROOT_CONTRACT_CONFLICT` if:

- a test requires changing current runtime in the fixture/test gate;
- golden v1 bytes or hashes cannot be reproduced from canonical source;
- a new public status, error, schema field, or enum is required beyond ADR-009;
- v2 fixtures cannot distinguish raw materialization from canonical payloads;
- shared Graph journal validation would need to become V4-only;
- a non-V4 receipt family would be reclassified or rejected;
- existing v1 evidence would be rewritten or rehashed;
- test ownership must extend beyond the allowed paths.

## Non-Claims

This task-pack does not authorize or prove:

- a v2 receipt runtime implementation;
- migration of current receipt writers or readers;
- production external-client enforcement;
- an enabled external endpoint;
- historical receipt classification as `local_operator`;
- universal journal or receipt coverage;
- ecosystem or V5 completion.
