# V4-B3A — YAGNI Scope Amendment

## Status

`BINDING_SCOPE_AMENDMENT_TO_V4_B3A_AUTHORIZATION`

This amendment supersedes only the previously authorized `graph.js` delegation
method and the six-file runtime scope in the V4-B3A authorization. All bounded
read, byte-limit, durable-authority, receipt-count, parity, verification and
stop-condition semantics remain unchanged.

Parent runtime issue: `#554`
Authorization merge: `65a454730929aa653a2bbfc8db7953687daadaf6`

## Source-Reality Finding

The original authorization proposed this extra Graph facade capability:

```text
Graph#iterateAuditEventsBounded(filters, options)
→ lib/audit-log.js::iterateAuditEventsBounded(this, filters, options)
```

Implementation review showed that this method would add no authority,
validation, persistence or product behavior. The generic audit owner already
receives the source object and can inspect the existing Graph SQLite/in-memory
owners directly. The only B3A consumer is
`lib/receipt/receipt-read-index.js`, which can call the generic audit helper with
its source object directly.

Therefore the Graph wrapper fails the binding YAGNI order:

```text
Does this need to exist? → no: skip it.
```

Touching the already-large `graph.js` for a pass-through method would also add a
public facade surface without a product requirement. Avoiding that touch is
stricter than the original design with respect to `ARCH-001`; it does not move
business logic into another legacy facade.

## Settled Replacement

The bounded source call is now:

```text
lib/receipt/receipt-read-index.js
→ lib/audit-log.js::iterateAuditEventsBounded(source, filters, options)
```

`lib/audit-log.js` owns the generic source adapter and is allowed to inspect the
existing Graph `_db`, `_stmts` and `_auditEvents` source owners exactly as
already authorized. `receipt-read-index` owns receipt-specific limits and
materialization. No new Graph method is created.

Existing `Graph#getAuditEvents()` is not modified. It remains the legacy
unbounded compatibility API and must continue to pass unchanged behavior tests.

## Amended Runtime Scope

The successor may change exactly five files:

```text
lib/json-utf8-size.js
lib/audit-log.js
lib/receipt/receipt-read-index.js
package.json
test/v4-b3a-bounded-receipt-export-source.test.js
```

`graph.js` is removed from the authorized write scope and is now explicitly
forbidden for B3A.

No sixth file is authorized.

## Acceptance Amendment

The original acceptance evidence remains binding except references requiring a
new Graph facade method are interpreted as follows:

- invoke `iterateAuditEventsBounded(graph, filters, options)` directly from the
  audit owner in focused source tests;
- prove real SQLite Graph behavior through that helper;
- prove `Graph#getAuditEvents()` output remains behavior-compatible without any
  edit to `graph.js`;
- prove the new bounded receipt export calls the generic audit helper and never
  falls back to `source.getAuditEvents()`.

All other acceptance items remain unchanged, including:

- no complete audit array materialization;
- no `.all()` in the new bounded path;
- workspace filter before SQLite details fetch;
- details byte preflight before full details fetch/parse;
- receipt #1025 stops the consumer;
- exact UTF-8 JSON byte accounting without whole over-limit serialization;
- existing canonical/hash/chain/bundle primitives unchanged;
- exact successful legacy parity with fixed `exportedAt`;
- durable/in-memory divergence fail closed;
- targeted, unchanged receipt tests, full `npm test`, package dry-run and
  runtime-executing CI before merge.

## Forbidden

In addition to the parent forbidden list:

- do not modify `graph.js`;
- do not add a Graph wrapper, alias or type declaration for this seam;
- do not expose the bounded iterator as a new public Graph API merely for future
  use;
- do not introduce another adapter module to replace the deleted pass-through.

If a real second production consumer later requires a public Graph capability,
that is a separate source-backed API decision rather than speculative B3A
surface.