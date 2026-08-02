# RECEIPT-TRUST-ROOT-4 — Migration and Compatibility Adversarial Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 81ec45135d44fcdd555d01e735e8b8bf6a4cbd4f`
- Predecessors: `ADR-009`, `RECEIPT-TRUST-ROOT-3`, `RECEIPT-TRUST-ROOT-3A`
- Mode: adversarial compatibility proof
- Runtime implementation in this authorization PR: forbidden
- Production V2 writer enablement: forbidden
- External endpoint work: forbidden

## Source-Reality Finding

The exact base already contains:

1. unchanged `v4-receipt-v1` canonical construction and golden byte/hash fixtures;
2. a pure `v4-receipt-v2` builder and exact trust-root validation;
3. V4-family version-aware chain validation with V1→V2 chronology and V2→V1 downgrade refusal;
4. version-aware materialized read and export dispatch;
5. bounded SQLite `receipt_family` metadata with `v4 | non-v4` only;
6. atomic legacy family migration and workspace-plus-family predecessor selection;
7. a durable-write guard that rejects V4 V2-or-later writes with `V4_RECEIPT_V2_WRITE_NOT_ENABLED`.

Existing RTR-3 and RTR-3A tests prove the positive foundation and several attack cases, but the closeout boundary still needs one exact adversarial suite that attacks migration, chain, reader and export behavior together without enabling a writer or rewriting historical evidence.

Graphify artifacts are absent on this exact base. Live source, tests, CI and exact Git evidence therefore control this task-pack.

## Decision

RTR-4 is initially **test-only**. The implementation PR may add exactly one new adversarial test owner and must first attempt to falsify the current behavior.

If a required test exposes a real contract gap, the implementation must stop after recording the red test and open a separate exact-base scope amendment naming the minimum authoritative production owner. Runtime fixes are not implicitly authorized by this task-pack.

This keeps the gate narrow: RTR-4 proves compatibility; it does not select a production V2 writer, change a public receipt shape, or broaden the receipt-family model.

## Authorized File

```text
test/receipt-trust-root-4-migration-compatibility.test.js
```

Read-only evidence owners:

```text
graph.js
lib/receipt/canonical-receipt.js
lib/receipt/canonical-receipt-v2.js
lib/receipt/receipt-chain.js
lib/receipt/receipt-export.js
lib/receipt/receipt-read-index.js
lib/receipt/v4-receipt-family.js
test/receipt-trust-root-v2-runtime.test.js
test/receipt-trust-root-3a-family-chain.test.js
test/fixtures/receipt-trust-root/*.json
```

No production file is authorized in the initial RTR-4 implementation PR.

## Required Adversarial Matrix

### A. SQLite migration integrity

Use real temporary SQLite files and prove:

1. a valid pre-family legacy table migrates once and reopening is idempotent;
2. payload bytes, predecessor hash, receipt hash, sequence, identities and timestamps remain unchanged across migration and reopen;
3. the exact `(workspace_id, receipt_family, sequence)` index exists;
4. a pre-existing family column that is nullable fails closed;
5. a bounded but payload-inconsistent family value fails closed;
6. a missing, partial or wrongly defined family index fails closed or is repaired only when repair is unambiguous and evidence-preserving;
7. malformed canonical JSON fails with exactly `RECEIPT_FAMILY_MIGRATION_FAILED` and never falls back to JSON;
8. no failed migration creates or mutates the JSON memory artifact;
9. V4 and non-V4 lineages remain isolated simultaneously across at least two workspaces;
10. no caller-controlled field can relabel stored family metadata.

### B. Historical V1 preservation

Use the checked-in fixture corpus and prove:

1. V1 canonical serialization bytes and canonical hash remain exact;
2. V1 chained record bytes and receipt hash remain exact;
3. V1-only bundle bytes and bundle hash remain exact;
4. every validator, reader and exporter used by RTR-4 leaves fixture inputs unchanged;
5. no `trustRoot`, discriminator or compatibility label is serialized into historical V1 evidence.

### C. V1→V2 chronology and downgrade refusal

Using pure in-memory V4 records only, prove:

1. `v1 -> v2 -> v2` validates without predecessor rewrite or rehash;
2. V2 trust roots remain exact and are never inferred from actor, metadata, source, transport or signature-like fields;
3. `v2 -> v1` fails with `V4_CHAIN_VERSION_REGRESSION` even when the downgraded record is freshly rehashed;
4. unsupported `v4-receipt-v*` versions fail with `UNSUPPORTED_RECEIPT_SCHEMA_VERSION` even when generic hash/link validation succeeds;
5. missing, unknown, inherited, accessor-backed, symbol-keyed, hidden or nested trust-root authority fails closed;
6. reordered, removed, inserted or rewritten records fail V4 validation unless an external expected artifact explicitly authorizes a different sequence;
7. generic non-V4 journal records remain valid under the unchanged generic chain primitive and are never relabelled V4.

### D. Materialized reader hardening

Prove:

1. discriminator-free historical receipts use the unchanged V1 projection;
2. declared V2 requires an exact valid top-level own enumerable data `trustRoot`;
3. unsupported discriminators return bounded invalid results and do not downgrade to V1;
4. read-by-id and chain materialization do not mutate source events or nested receipt objects;
5. a failed receipt in a materialized sequence returns no partial successful chain;
6. workspace filtering cannot leak a receipt from another workspace;
7. duplicate or malformed authority-bearing objects cannot bypass classification through prototypes, accessors, symbols or non-enumerable fields;
8. reader results do not fabricate a trust-root assertion for V1.

### E. Export and independent verification

Prove:

1. V1-only exports remain `v4-receipt-bundle-v1` with the historical golden bytes/hash;
2. any valid V4 export containing V2 selects `v4-receipt-bundle-v2`;
3. verification checks outer bundle version, complete receipt-array hash, exact V4 record shapes, trust roots, chronology and chain linkage;
4. unsupported receipt versions, invalid roots, rewritten V1 evidence, reordering and mixed receipt families fail closed;
5. export and verification leave input chains and bundles unchanged;
6. non-V4 receipt families cannot enter a V4 bundle even when their generic hash/link record is internally valid;
7. an existing exported artifact is verified as supplied and is never regenerated or normalized in place.

### F. Durable writer remains closed

Use real SQLite and prove:

1. a V4 V2 durable write still throws `V4_RECEIPT_V2_WRITE_NOT_ENABLED`;
2. the rejected attempt leaves graph state, journal, receipt table and replay state unchanged;
3. no test helper or fixture creates a production writer or labels an existing callsite `local_operator` / `external_verified_client`.

## Acceptance Commands

```bash
node --test test/receipt-trust-root-4-migration-compatibility.test.js
node --test --test-concurrency=1 test/receipt-trust-root-v2-runtime.test.js test/receipt-trust-root-3a-family-chain.test.js test/v4-receipt-materialization-read-index.test.js test/v4-trust-receipt-primitive.test.js
npm test
git diff --check
git status --short
```

Expected:

- zero failing tests;
- exact one-file implementation diff;
- no production or fixture mutation;
- V1 golden bytes/hashes unchanged;
- V2 durable writes still rejected.

## Compatibility Requirements

- No historical V1 payload, chain record, hash or bundle artifact is rewritten.
- No new schema version, trust-root value or receipt family is introduced.
- Existing public builders, readers, exporters, validators and Graph APIs remain unchanged.
- Generic non-V4 chain semantics remain unchanged.
- Existing reviewed-external receipt semantics remain unchanged.
- No JSON fallback is allowed for typed receipt-family migration integrity failures.
- Tests must not depend on wall-clock ordering, network access or external services.

## Stop Conditions

Stop and open a separate scope amendment if any required proof needs:

- a production file change;
- production V2 writer enablement or trust-root ownership selection;
- historical row rewrite, backfill or rehash;
- a third trust-root value or receipt family;
- public receipt/read/export shape changes;
- changes to Kernel, CLI, MCP, HTTP, SDK, adapters, builders or reviewed-external writers;
- weakening fail-closed migration, chain, reader or export behavior;
- release, deployment, package-version, dependency or configuration changes.

## Definition of Done

RTR-4 closes only when:

1. the exact adversarial suite exists in the authorized file;
2. targeted, related and full regression tests pass with zero failures;
3. exact-head Security Checks and required CI checks are green;
4. the diff is exactly one new test file;
5. an adversarial review confirms V1 evidence is unchanged and V2 production writing remains disabled;
6. the merge SHA and post-merge source are recorded in the mutable checkpoint and execution control before RTR-5 authorization starts.

## Non-Claims

This task-pack does not claim or authorize:

- a production V2 receipt writer;
- authoritative `local_operator` or `external_verified_client` writer ownership;
- historical V1 trust-root classification;
- a universal receipt-family registry;
- external endpoint reachability;
- V4 Workbench closeout;
- V5 ecosystem readiness or completion.
