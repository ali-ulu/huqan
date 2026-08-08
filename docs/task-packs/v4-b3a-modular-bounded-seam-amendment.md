# V4-B3A — Modular Bounded-Seam Amendment

## Status

`BINDING_MODULARITY_AMENDMENT_TO_V4_B3A_AUTHORIZATION`

This amendment supersedes only the runtime-file placement from the previous
V4-B3A authorization/amendments. All product semantics, fail-closed rules,
limits, durable-authority rules, legacy parity requirements, acceptance tests
and stop conditions remain binding.

Parent runtime issue: `#554`
Latest controlling main before this amendment:
`a193673eca014c3b223aea27a3d49c6fefd41f33`

## Source-backed reason

Implementation dry-run exposed a concrete touched-area modularity problem before
opening the runtime PR:

- placing the bounded source implementation into `lib/audit-log.js` expands a
  small generic audit primitive with a distinct SQLite streaming/read-budget
  responsibility and pushes the file toward/over the project's preferred
  250–300-line production-file ceiling;
- placing the full bounded receipt-export policy into
  `lib/receipt/receipt-read-index.js` expands the existing materialized read
  index by roughly two hundred lines and would leave the production file well
  over the same ceiling;
- neither expansion is required to preserve an existing public API because the
  new bounded path has no production consumer yet; B3 will be the first
  consumer after this prerequisite closes.

The binding engineering order therefore applies:

```text
Already in this codebase? → reuse it, don't rewrite.
New responsibility?       → put the minimum owner in a narrow module.
Existing large file?       → do not make it larger merely for a pass-through.
```

A new module is justified here because each module owns an immediately required
responsibility; these are not speculative future abstractions.

## Settled module ownership

### `lib/json-utf8-size.js`

Dependency-free exact JSON UTF-8 byte counter with hard short-circuit. It owns no
audit or receipt semantics.

### `lib/audit-bounded-read.js`

Owns the new read-only bounded source adapter:

```text
iterateAuditEventsBounded(source, filters, options)
```

It reuses `normalizeAuditEvent` from `lib/audit-log.js`; it does not duplicate
normalization or change existing audit APIs.

It may inspect the already-existing Graph source owners `_db`, `_stmts` and
`_auditEvents` exactly as authorized previously. It owns:

- workspace-scoped SQLite keyset/streaming read;
- persisted `details` byte-length preflight before full details fetch/parse;
- one-event-at-a-time materialization;
- durable-row versus process-local duplicate agreement checking;
- fail-closed source divergence;
- in-memory one-event-at-a-time iteration.

It does not mutate Graph/audit state, create schema/indexes, or expose a Graph
facade method.

### `lib/receipt/bounded-receipt-export.js`

Owns the B3A receipt-specific policy:

- canonical `default` workspace only;
- hard maxima: 1024 unique receipts and 2 MiB serialized bundle bytes;
- stop at unique receipt 1025;
- preflight canonical/hash input size before existing chain hashing;
- exact aggregate receipt-array accounting before retaining an over-limit
  record;
- existing `exportReceiptBundle()` + `verifyExportedBundle()` reuse;
- exact final bundle byte measurement;
- no partial/truncated bundle;
- successful fixed-`exportedAt` parity with legacy
  `exportMaterializedReceiptBundle()`.

It reuses the already-exported `receiptToCanonicalPayload()` from
`lib/receipt/receipt-read-index.js`; it does not copy that canonicalization
logic and does not modify the legacy read-index file.

## Final amended runtime scope

The B3A successor may change exactly five files:

```text
lib/json-utf8-size.js
lib/audit-bounded-read.js
lib/receipt/bounded-receipt-export.js
package.json
test/v4-b3a-bounded-receipt-export-source.test.js
```

No sixth file is authorized.

Explicitly forbidden for B3A now:

```text
graph.js
lib/audit-log.js
lib/receipt/receipt-read-index.js
lib/receipt/canonical-receipt.js
lib/receipt/canonical-receipt-v2.js
lib/receipt/receipt-chain.js
lib/receipt/receipt-export.js
```

The package change may add only these three new runtime modules to the existing
`files` allowlist:

```text
lib/audit-bounded-read.js
lib/json-utf8-size.js
lib/receipt/bounded-receipt-export.js
```

No dependency or other package metadata change is authorized.

## Size discipline

Each new production module should remain at or below 300 physical lines. If a
module cannot meet that ceiling without compressing distinct responsibilities
into unreadable code, stop with `V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_BLOCKED_GAP`
rather than silently widening scope again.

The focused test file may exceed 300 lines if required for adversarial evidence;
test-file size is not a product gate.

## Acceptance amendment

All earlier B3A acceptance requirements remain binding, interpreted against the
new owners:

1. existing `Graph#getAuditEvents()` and `lib/audit-log.js` behavior pass
   unchanged because neither production file is edited;
2. focused tests call
   `lib/audit-bounded-read.js::iterateAuditEventsBounded(graph, ...)` directly;
3. the bounded receipt exporter imports that helper and never calls legacy
   `source.getAuditEvents()`;
4. the receipt exporter imports and reuses
   `receiptToCanonicalPayload()` from the unchanged read-index;
5. real SQLite evidence proves no complete audit `.all()` in the bounded path;
6. workspace filtering happens before full SQLite details fetch;
7. oversized selected-workspace details fail before full value fetch/parse;
8. durable/in-memory same-`auditId` disagreement fails closed;
9. sparse unrelated audit events do not consume the unique-receipt budget;
10. unique receipt 1025 stops the consumer immediately;
11. exact JSON UTF-8 size equality is proved against
    `Buffer.byteLength(JSON.stringify(value), 'utf8')` for JSON-safe fixtures;
12. an over-limit value is rejected without whole-value JSON serialization;
13. aggregate receipt-array and final bundle boundaries are exact;
14. successful bounded exports have exact legacy receipt/hash/bundle parity for
    fixed `exportedAt`;
15. `verifyExportedBundle()` accepts successful bounded output and detects
    tampering;
16. unchanged trust-receipt/read-index tests pass;
17. package dry-run contains all three new runtime files;
18. exact-head targeted tests, full `npm test`, runtime CI and scope diff are
    green before merge.

## Non-claims

This amendment does not claim constant-time historical receipt lookup. With the
current schema, sparse history may require a linear, one-row-at-a-time scan.
It only forbids unbounded materialization/serialization and unbounded retained
receipt state.

No HTTP route, server wiring, Workbench UI, CLI/MCP surface or V5 surface is
authorized here.