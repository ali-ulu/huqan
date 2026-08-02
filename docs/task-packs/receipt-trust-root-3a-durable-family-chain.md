# RECEIPT-TRUST-ROOT-3A — Durable Family-Scoped Chain Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ 16c5b337a7d4db5ce65d4a7749b81f9c258b5df4`
- Predecessors: `ADR-008`, `ADR-009`, `RECEIPT-TRUST-ROOT-3`
- Mode: implementation scope definition
- Runtime implementation in this task-pack: forbidden
- External endpoint work: forbidden
- Production V2 writer enablement: forbidden

## Source-Reality Finding

The SQLite `mutation_receipts` table currently stores one sequence for every
receipt written through `Graph.runMutationOnce()`. Its predecessor query is:

```sql
SELECT receipt_hash
FROM mutation_receipts
WHERE workspace_id = ?
ORDER BY sequence DESC
LIMIT 1
```

The table has no receipt-family column. Consequently, the next V4 canonical
receipt and the next reviewed-external receipt can select each other as a
predecessor when they share a workspace. The generic hash/link primitive is
valid for either record, but this does not prove a V4-family chain.

Current production writers are bounded as follows:

1. `kernel.js` builds the existing `v4-receipt-v1` canonical payload for a
   journaled durable learn.
2. `lib/reviewed-external-graph-execution.js` builds the separately versioned
   `huqan.reviewed-external-graph-receipt.v1` payload.
3. `graph.js` owns transaction, predecessor selection, chain append, receipt
   insertion, mutation-journal insertion, rollback and replay.
4. `lib/receipt/v4-receipt-family.js` classifies canonical V4 payloads as
   `v4`; all existing separately versioned payloads remain `non-v4` for this
   bounded migration.
5. Durable V4 V2 writes remain rejected by
   `V4_RECEIPT_V2_WRITE_NOT_ENABLED`.

Graphify artifacts are absent on the exact base. Live source, tests and exact
Git evidence therefore control this task-pack.

## Decision

RTR-3A authorizes a database metadata migration and runtime predecessor change
that separates the existing durable receipt table into two bounded lineages:

```text
v4
non-v4
```

This is not a universal receipt-family registry. It separates V4 canonical
admission receipts from the existing non-V4 receipt path while preserving the
shared generic hash/link primitive.

### Database migration

`mutation_receipts` gains one internal column:

```sql
receipt_family TEXT NOT NULL
```

Allowed values in this gate are exactly:

```text
v4
non-v4
```

New databases create the column directly. Existing databases are migrated in
one SQLite transaction:

1. add the column with a temporary bounded default;
2. read every existing `canonical_payload` without mutating it;
3. parse the stored JSON;
4. derive the family through the existing `classifyReceiptFamily()` contract;
5. update only the new metadata column;
6. verify that every row has exactly `v4` or `non-v4`;
7. create an index over `(workspace_id, receipt_family, sequence DESC)`.

Historical canonical payload bytes, `previous_receipt_hash`, `receipt_hash`,
operation IDs, receipt IDs, sequence values and committed timestamps must not
change.

Malformed stored JSON, an incomplete backfill, an invalid family value or a
migration write-count mismatch fails closed with exactly:

```text
RECEIPT_FAMILY_MIGRATION_FAILED
```

That failure must not silently downgrade the Graph to the JSON backend. The
constructor may preserve its existing fallback for ordinary SQLite-open
failures, but this typed integrity failure must be rethrown.

### Family-scoped predecessor selection

`Graph.runMutationOnce()` derives `receipt_family` from the built canonical
payload. Callers cannot provide or override it.

The predecessor query becomes scoped by both workspace and derived family:

```sql
SELECT receipt_hash
FROM mutation_receipts
WHERE workspace_id = ? AND receipt_family = ?
ORDER BY sequence DESC
LIMIT 1
```

The insert stores the same derived family in the new metadata column. The
public committed-receipt object returned by Graph remains byte- and
shape-compatible; `receiptFamily` is not added to that public object in this
gate.

The resulting rule is:

```text
same workspace + same bounded family -> predecessor
other workspace or other family      -> never predecessor
```

### Authoritative ownership

Ownership is explicit and remains narrow:

| Responsibility | Authoritative owner |
| --- | --- |
| Family derivation | `graph.js`, using `classifyReceiptFamily()` on the completed payload |
| Predecessor lookup | `graph.js` inside the existing SQLite transaction |
| Chain append and durable insertion | `graph.js` |
| Existing V4 V1 payload construction | current journaled Kernel learn writer |
| Existing reviewed-external payload construction | `lib/reviewed-external-graph-execution.js` |
| V2 trust-root selection | no production owner in RTR-3A |

Neither a business payload, transport, plugin, receipt callback nor Graph
option may self-declare `receipt_family` or a V2 `trustRoot`.

## Production V2 Writer Decision

RTR-3A does **not** enable a production V2 writer.

The generic Kernel durable-learn path is reachable from more than one client
surface and is not itself proof of an explicitly local-only authority. The
reviewed-external path uses its own non-V4 receipt family and is not the future
external verified-client endpoint defined by ADR-008.

Therefore:

- the current Kernel writer remains V4 V1;
- reviewed-external execution remains non-V4;
- `assertDurableV4WriteAllowed()` continues rejecting V4 V2 and later writes;
- no existing CLI, MCP, HTTP, SDK, plugin or adapter callsite is relabelled as
  `local_operator` or `external_verified_client`;
- V2 writer ownership remains closed until a later exact callsite proves the
  corresponding trust boundary.

This is an ownership decision, not an incomplete migration claim.

## Allowed Runtime Files

```text
graph.js
```

Allowed test ownership:

```text
test/receipt-trust-root-3a-family-chain.test.js
```

Read-only regression owners:

```text
test/receipt-trust-root-v2-runtime.test.js
test/durable-mutation-journal.test.js
test/reviewed-external-graph-execution.test.js
test/reviewed-external-graph-execution-integrity.test.js
test/v4-receipt-materialization-read-index.test.js
test/v4-trust-receipt-primitive.test.js
```

No other production file is authorized. If implementation requires changes to
`kernel.js`, `mcpServer.js`, `server.js`, `cli.js`, `lib/sdk.js`, a receipt
builder, reader, exporter or reviewed-external writer, stop and open a new
scope decision.

## Required Adversarial SQLite Tests

The implementation test must use real temporary SQLite files and prove:

1. a legacy database without `receipt_family` migrates atomically;
2. existing V4 rows become `v4` and reviewed-external rows become `non-v4`;
3. migration changes no historical canonical payload, predecessor hash,
   receipt hash, sequence or timestamp;
4. the index exists after migration;
5. a new V4 V1 receipt follows the latest V4 receipt, not a later non-V4 row;
6. a new non-V4 receipt follows the latest non-V4 receipt, not a later V4 row;
7. workspace isolation and family isolation hold simultaneously;
8. replay returns the original result and receipt without inserting another
   family row;
9. callback failure, duplicate receipt identity and SQLite insertion failure
   leave mutation, journal, receipt and in-memory Graph state unchanged;
10. a caller cannot override the derived family through payload metadata,
    callback options or nested fields;
11. a durable V4 V2 write is still rejected with
    `V4_RECEIPT_V2_WRITE_NOT_ENABLED` and leaves zero state;
12. malformed legacy canonical JSON or incomplete migration fails with
    `RECEIPT_FAMILY_MIGRATION_FAILED` and does not fall back to JSON;
13. reviewed-external execution and its exact receipt shape remain unchanged;
14. existing V1 durable-journal and historical byte/hash tests remain green.

The migration test must include an interleaved legacy sequence in one
workspace so a workspace-only predecessor implementation cannot pass
vacuously.

## Required Commands

```text
node --test test/receipt-trust-root-3a-family-chain.test.js
node --test --test-concurrency=1 test/receipt-trust-root-v2-runtime.test.js test/durable-mutation-journal.test.js test/reviewed-external-graph-execution.test.js test/reviewed-external-graph-execution-integrity.test.js test/v4-receipt-materialization-read-index.test.js test/v4-trust-receipt-primitive.test.js
npm test
git diff --check
git status --short
```

## Compatibility Requirements

- Existing public `Graph.runMutationOnce()` arguments and return shape remain
  unchanged.
- Existing V1 canonical bytes and hashes remain unchanged.
- Existing reviewed-external receipt payload and public record shape remain
  unchanged.
- Existing operation replay semantics remain unchanged.
- The shared `appendReceiptToChain()` and `validateReceiptChain()` primitives
  remain unchanged.
- No historical row is deleted, reordered, rehashed or backfilled with a
  trust root.
- No new package export, dependency, configuration flag, route or public
  status is introduced.

## Stop Conditions

Stop if implementation requires:

- enabling any V2 production writer;
- inferring `local_operator` or `external_verified_client` from a client,
  actor, transport, source, signature or metadata field;
- more than the two bounded persistence families in this gate;
- rewriting any historical receipt payload or hash;
- changing a public receipt/read/export shape;
- narrowing the generic chain primitive to V4 only;
- weakening JSON-backend refusal or SQLite rollback semantics;
- adding a second new error code;
- modifying files outside the allowed runtime and test ownership;
- enabling an external endpoint or changing CLI/MCP/SDK behavior.

## Definition of Done

RTR-3A closes only when:

- the exact migration and family-scoped predecessor behavior are implemented
  in the allowed files;
- all targeted, related and full regression tests pass with zero failures;
- exact-head Security Checks and required CI status checks are green;
- the diff is scope-clean;
- an adversarial review confirms that V2 production writing remains disabled;
- the merge SHA and post-merge source are recorded in the mutable checkpoint
  and execution control before RTR-4 authorization starts.

## Non-Claims

This task-pack does not claim or authorize:

- a production V2 receipt writer;
- local-operator classification of historical V1 receipts;
- external verified-client receipt production;
- a universal receipt-family registry;
- historical chain rewriting or backfill;
- external endpoint reachability;
- V4 Workbench closeout;
- V5 ecosystem readiness or completion.
