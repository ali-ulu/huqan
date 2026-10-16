# V4-B3A — Bounded Receipt Export Source / Serialization Authorization

## Status

`AUTHORIZED_FOR_SOURCE_SEAM_IMPLEMENTATION`

This task-pack authorizes one narrow prerequisite repair for V4-B3. It does not
implement or register the V4-B3 HTTP export route, does not close V4-B3, and
does not open V4-B5 or V5.

Parent issue: `#271`
Authorization issue: `#549`

## Exact Source Baseline

```text
repository: ali-ulu/huqan
base branch: main
observed live main: 8b3227fc41dfaffbb6f50ba183f86260d4aa11a4
parent B3 authorization artifact: 7446642
```

The implementation successor opens from live `origin/main` after this
authorization merges. Live source, exact Git SHA, tests and CI outrank this
document. A later change to any authorized production file requires a fresh
source-compatibility check before implementation.

## Source-Reality Verdict

The current V4-B3 implementation contract cannot be implemented truthfully
inside its six-file scope.

The controlling parent verdict is:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP
```

Two independent source facts establish the block.

### 1. The source is materialized without a bound

`lib/receipt/receipt-read-index.js` currently does this:

```text
collectMaterializedReceiptEntries()
→ getAuditEvents(source, { workspaceId })
→ source.getAuditEvents(filters)
→ clone every unique materialized receipt
→ build the complete receipt chain
→ exportReceiptBundle()
```

No count/cursor/iterator reaches the underlying source before the complete audit
result is returned.

On SQLite Graph, `graph.js::getAuditEvents()` executes:

```text
this._stmts.allAuditEvents.all()
```

and only then merges, sorts and filters. The prepared statement is an unbounded
`SELECT * FROM audit_log ORDER BY timestamp ASC, audit_id ASC`.

`lib/audit-log.js::getAuditEvents()` is also an array filter, not a bounded read
primitive.

Therefore checking `MAX_RECEIPTS` after `getAuditEvents()` would cap the output
but not the read/materialization cost. That is explicitly insufficient for B3.

### 2. The byte ceiling is observable only after aggregate serialization

`lib/receipt/receipt-export.js::exportReceiptBundle()` calculates the bundle
hash from:

```text
stableStringify(receipts)
```

`lib/receipt/canonical-receipt.js::stableStringify()` recursively constructs a
sorted object and then calls `JSON.stringify()` over the complete value.
Receipt-chain hashing uses the same canonical serialization path.

A route-level `Buffer.byteLength(JSON.stringify(bundle))` after this work would
therefore measure the right payload too late: the aggregate string has already
been created.

### 3. Parent package reconciliation is stale again

The B3 task-pack's previous reconciliation covered a `package.json` change whose
only differing top-level key was `files`. Live main now also contains the PR
#538 `pdfkit` dependency. The previous files-only reconciliation is not a
standing exemption and cannot authorize B3 implementation on the current tree.

B3A supersedes implementation attempts until the source/serialization gap is
closed. The old B3 route scope remains suspended, not expanded.

## Settled Product Decisions

### 1. Parent B3 semantics do not change

B3A exists only to make the already-authorized B3 limits real. It does not
reopen these parent decisions:

```text
workspace: canonical default only
MAX_RECEIPTS: 1024
MAX_SERIALIZED_BUNDLE_BYTES: 2 * 1024 * 1024
verification: mandatory before response body
redaction: none; internal/full trust artifact
partial/truncated/paginated bundle: forbidden
```

A public-safe/redacted receipt remains V5-C4 work.

### 2. The new source primitive is an iterator, not a bigger array

A bounded receipt export must consume audit events incrementally. The new Graph
surface is one read-only iterator capability:

```text
iterateAuditEventsBounded(filters, options)
```

The exact exported name may differ only if an existing repository naming rule
requires it; semantics may not differ.

Required semantics:

- workspace filtering occurs at the source before materializing event details;
- SQLite rows are visited in canonical `(timestamp ASC, audit_id ASC)` order;
- rows are not collected through `.all()` first;
- one event is materialized at a time;
- the caller can stop iteration immediately after the `MAX_RECEIPTS + 1`th
  unique receipt is found;
- unrelated audit events do not consume the receipt-count budget;
- duplicate receipt IDs preserve the current read-index first-seen behavior;
- the iterator never mutates Graph or audit state;
- existing `getAuditEvents()` behavior remains unchanged.

The bounded iterator is an additional source seam. It is not a rewrite of all
audit reads.

### 3. SQLite must reject oversized details before fetching/parsing them

For SQLite, selecting an arbitrarily large `details` cell and checking its size
in JavaScript is still a too-late materialization.

The source owner must first inspect persisted UTF-8 byte length without
selecting the full details value. The intended contract is equivalent to:

```sql
SELECT
  audit_id,
  event_type,
  target_type,
  target_id,
  workspace_id,
  actor,
  timestamp,
  source_ref,
  provenance_id,
  trust_policy_version,
  length(CAST(details AS BLOB)) AS details_bytes
FROM audit_log
WHERE workspace_id = ?
ORDER BY timestamp ASC, audit_id ASC
```

Only a row whose `details_bytes` is within the caller-provided hard ceiling may
have its `details` value fetched and parsed. An oversized row fails closed; it
is not skipped, truncated, sampled or partially parsed.

No schema migration or new index is authorized. The existing
`idx_audit_workspace_timestamp` is reused.

For the JSON/in-memory backend, events already exist as objects. The iterator
walks them one at a time and applies the same byte guard before any new clone or
canonicalization. B3A does not claim restart durability for a backend that does
not already own it.

### 4. Receipt count is counted on unique materialized receipt IDs

The parent ceiling is `MAX_RECEIPTS`, not `MAX_AUDIT_EVENTS`.

The bounded collector therefore:

1. iterates audit events in canonical order;
2. ignores events without a plain-object `details.receipt`;
3. ignores duplicate receipt IDs after the first seen instance;
4. stops and returns the parent B3 limit outcome as soon as unique receipt
   number `MAX_RECEIPTS + 1` is observed.

It must not request all remaining audit events after the limit is known.

The `seen` receipt-ID set is therefore bounded by at most 1025 entries for the
B3 call.

### 5. Byte measurement is exact and pre-allocation

B3A authorizes one small generic helper:

```text
lib/json-utf8-size.js
```

Its job is to count the exact number of UTF-8 bytes that Node's JSON encoding
would emit for the JSON-safe values used by receipt/audit objects, with a hard
`maxBytes` short-circuit.

It must not create the complete serialized string in order to count it.

The helper must correctly account for at least:

- object/array punctuation and separators;
- JSON string quotes and escapes;
- UTF-8 width of BMP and surrogate-pair characters;
- lone-surrogate escaping used by current Node JSON serialization;
- numbers, booleans and `null`;
- circular/unsupported values as fail-closed errors.

For the JSON-safe canonical receipt structures used here, sorting object keys
changes order but not serialized byte count. Therefore the same exact byte
counter can safely guard both ordinary final JSON serialization and the
existing stable-key hash serialization without replacing either serializer.

### 6. Existing receipt hashes and bundle bytes remain authoritative

B3A does **not** authorize a new canonical serializer or new hash algorithm.

The flow is:

```text
bounded source read
→ canonical payload construction
→ exact preflight byte measurement
→ existing appendReceiptToChain()
→ exact aggregate receipt-array byte accounting
→ existing exportReceiptBundle()
→ existing verifyExportedBundle()
→ exact final JSON byte measurement
```

The existing `stableStringify()`, `hashCanonicalReceiptPayload()`,
`appendReceiptToChain()`, `exportReceiptBundle()` and `verifyExportedBundle()`
remain unchanged.

This is deliberate. The new helper proves that the existing serializer will
only be invoked on a value already known to be within the parent ceiling; it
does not replace the serializer whose bytes and hashes are already historical
contracts.

For the same input receipts and a fixed `exportedAt`, a successful bounded
export must be deep-equal to the current legacy export and must carry the exact
same receipt hashes and bundle hash.

### 7. Aggregate memory is bounded before bundle export

The bounded collector maintains the exact JSON byte size of the receipt array as
records are appended:

```text
2 bytes for []
+ exact bytes of each chained receipt
+ one comma between records
```

If adding the next record would push the receipts array above the 2 MiB parent
ceiling, the operation fails before storing that record in the aggregate chain.

This preflight is intentionally conservative with respect to the full bundle:
the final bundle contains fixed envelope fields in addition to the receipt
array. After `exportReceiptBundle()` builds the already-bounded bundle, exact
final JSON byte measurement is mandatory. If the full bundle exceeds 2 MiB, it
fails with the parent `413` outcome and no bundle is returned.

Because the receipt array is already at or below the ceiling,
`exportReceiptBundle()` cannot create an aggregate receipts serialization larger
than the ceiling before that final check.

### 8. No HTTP route in B3A

B3A closes the prerequisite source/serialization seam only.

It does not modify:

- `lib/workbench/workbench-read-http-router.js`;
- `lib/http/route-auth-policy.js`;
- `server.js`;
- CLI, MCP or UI surfaces.

After B3A implementation is proved and merged, B3 requires a source-reality
resumption reconciliation. That reconciliation must account for the new bounded
primitive and the current `package.json` drift before the old six-file route
implementation may resume.

## Thin-Seam Design

The implementation is deliberately split at existing ownership boundaries.

### `lib/json-utf8-size.js`

One dependency-free exact JSON UTF-8 byte counter. Target: at or below 200
physical lines. It owns no receipt semantics.

### `lib/audit-log.js`

Own the generic bounded audit-event iterator helper beside the existing audit
normalization/filter functions. It may inspect the Graph source passed to it but
must not mutate it.

### `graph.js`

Add only a thin public delegation method to the audit helper. No SQL policy,
receipt logic, byte-count logic or B3-specific domain behavior may be added
inline to this already-large facade.

### `lib/receipt/receipt-read-index.js`

Add a new bounded export path that consumes only the bounded iterator, preserves
the existing receipt classifier/canonicalization/chain/export primitives, owns
the 1024 unique-receipt limit and enforces the 2 MiB preflight/final checks.

The legacy list/read/export functions remain available and behavior-compatible;
B3A does not silently change their public semantics.

## Authorized Implementation Files

The successor may change exactly:

```text
lib/json-utf8-size.js
lib/audit-log.js
graph.js
lib/receipt/receipt-read-index.js
package.json
test/v4-b3a-bounded-receipt-export-source.test.js
```

No seventh file is authorized.

File purposes:

- `lib/json-utf8-size.js`: dependency-free exact bounded byte measurement.
- `lib/audit-log.js`: bounded audit iterator implementation for SQLite and
  in-memory sources.
- `graph.js`: thin delegation only.
- `lib/receipt/receipt-read-index.js`: new bounded materialization/export owner;
  no rewrite of existing read APIs.
- `package.json`: add only `lib/json-utf8-size.js` to the existing sorted
  `files` allowlist. The existing `pdfkit` dependency is preserved exactly; no
  dependency or other package metadata change is authorized.
- `test/v4-b3a-bounded-receipt-export-source.test.js`: all behavior locks,
  parity, adversarial and resource-bound evidence.

## Required Acceptance Evidence

The exact-head implementation test must prove all of the following.

### Audit-source behavior

1. Existing `Graph#getAuditEvents()` produces the same ordered/deep-equal result
   before and after the change for in-memory and SQLite-backed fixtures.
2. The new SQLite iterator reads a workspace in `(timestamp, auditId)` order
   without invoking `allAuditEvents.all()`.
3. A large number of unrelated audit events before/between receipt events does
   not consume the 1024 receipt limit or cause an audit array to be returned.
4. Iteration stops immediately after the 1025th unique receipt ID; a probe source
   proves no later event is requested.
5. Duplicate receipt IDs count once and preserve first-seen behavior.
6. A SQLite row whose persisted details byte length exceeds the caller ceiling
   fails before its full details value is fetched/parsed.
7. In-memory oversized details fail before any new deep clone or canonical
   receipt copy is created.
8. Workspace filtering happens before SQLite details materialization; a huge row
   in another workspace does not block canonical `default` export.

### Byte-counter behavior

9. For representative ASCII, Turkish, emoji, escaped control characters,
   quotes/backslashes, arrays, nested objects, V1 canonical receipts, V2
   canonical receipts and complete exported bundles, the byte helper returns
   exactly:

   ```text
   Buffer.byteLength(JSON.stringify(value), 'utf8')
   ```

   when the reference serialization is intentionally allowed in the test.
10. Boundary tests at `limit - 1`, `limit`, and `limit + 1` prove exact cutoff
    behavior.
11. A very large string is rejected by the helper without first creating its
    complete JSON-escaped serialization.
12. Circular and unsupported values fail closed rather than recursing forever
    or silently changing receipt meaning.

### Receipt/export behavior

13. Zero receipts returns a successful empty bundle that
    `verifyExportedBundle()` accepts.
14. 1 through 1024 unique receipts can be consumed when their exact bytes remain
    under the byte ceiling.
15. Receipt 1025 produces the parent count-limit outcome with no partial bundle.
16. One oversized receipt/event produces the byte-limit outcome with no bundle.
17. Multiple individually-valid receipts whose aggregate receipt-array bytes
    cross 2 MiB fail before the over-limit record is retained in the aggregate
    chain.
18. A receipt array below 2 MiB whose full bundle envelope crosses 2 MiB fails
    at the exact final-bundle check with no bundle returned.
19. Broken/invalid V1 or V2 receipt material still fails closed with the existing
    chain/family error semantics; B3A may not turn invalid data into a size
    result merely to obtain green tests.
20. For the same bounded source, canonical workspace and fixed `exportedAt`, the
    new successful bounded export is deep-equal to
    `exportMaterializedReceiptBundle()` and has identical receipt hashes,
    `bundleHash`, schema version and receipt count.
21. `verifyExportedBundle()` accepts the bounded export and still detects
    post-export tampering.
22. Existing `test/v4-trust-receipt-primitive.test.js` and
    `test/v4-receipt-materialization-read-index.test.js` pass unchanged.
23. `package.json` changes only inside `files`, adding exactly
    `lib/json-utf8-size.js`; the existing `pdfkit` dependency is not modified.
24. `npm pack --dry-run --json --ignore-scripts` contains the new helper and all
    existing receipt runtime files.
25. Full `npm test` passes on the exact implementation head.

The implementation candidate must finish with exactly one verdict:

```text
V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_SUFFICIENT
V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_BLOCKED_GAP
```

A blocked verdict is valid evidence and must not be hidden by relaxing either
parent ceiling.

## Forbidden

- No B3 HTTP route, auth-policy registration or server wiring.
- No CLI, MCP, UI, external-client, release or deployment change.
- No redaction, masking, field stripping or public-safe receipt format.
- No receipt schema version, hash algorithm, stable serializer, chain linkage or
  bundle schema change.
- No dependency addition/removal/update.
- No database schema/table/index migration.
- No change to `server.js`, `kernel.js`, `storage.js`, plugins,
  `lib/receipt/canonical-receipt.js`, `lib/receipt/canonical-receipt-v2.js`,
  `lib/receipt/receipt-chain.js` or `lib/receipt/receipt-export.js`.
- No use of `getAuditEvents()` followed by a limit while claiming the source is
  bounded.
- No `.all()` over the complete audit table in the new bounded path.
- No approximation of serialized bytes from receipt count, character count or
  average receipt size.
- No `JSON.stringify(wholeValue)` or `stableStringify(wholeValue)` merely to
  discover that the value was already over the byte ceiling.
- No skipping oversized/corrupt events to manufacture a successful bundle.
- No partial, truncated or paginated bundle.
- No modification of existing `getAuditEvents()` semantics to make the new test
  easier.
- No V4-B3, V4-B5, V4-complete or V5-complete claim from B3A alone.

## Stop Conditions

Stop and emit `V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_BLOCKED_GAP` if any of the
following is proved:

- SQLite cannot inspect persisted `details` byte length before fetching the full
  details value without a schema/migration change;
- the required iterator cannot preserve canonical workspace/order semantics
  without materializing the complete audit set;
- exact JSON UTF-8 byte measurement cannot be made equivalent to current Node
  serialization for the JSON-safe receipt structures without replacing the
  historical serializer;
- existing receipt/hash/bundle bytes change on any valid bounded fixture;
- existing `getAuditEvents()` behavior must change;
- Graph requires more than thin delegation and the needed extraction cannot fit
  the authorized files;
- an unlisted production or test file must change;
- package reachability requires a dependency or unrelated publication change;
- local/full regression exposes a source conflict with this contract.

## Validation Commands

```bash
node scripts/agent-context.js
node --test test/v4-b3a-bounded-receipt-export-source.test.js
node --test test/v4-trust-receipt-primitive.test.js
node --test test/v4-receipt-materialization-read-index.test.js
node --test test/v4-wb2-memory-context-audit-source.test.js
npm test
npm pack --dry-run --json --ignore-scripts
git diff --check
git status --short
```

Connector-only review must record local bootstrap, worktree state, local test
commands, package dry-run and Graphify as unverified rather than inventing
results.

## Successor Order

```text
B3A authorization merge
→ B3A bounded source/serialization implementation
→ exact-head targeted + full regression + package evidence
→ B3A reconciliation/closure
→ B3 parent task-pack source-reality resumption reconciliation
→ only then B3 HTTP receipt-bundle route implementation
```

This order keeps the route small and prevents an output-only ceiling from being
misrepresented as a bounded source read.