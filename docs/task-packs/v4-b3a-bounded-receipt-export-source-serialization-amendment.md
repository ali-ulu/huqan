# V4-B3A — Audit-Source Authority Amendment

## Status

`BINDING_AMENDMENT_TO_V4_B3A_AUTHORIZATION`

This amendment is part of the V4-B3A authorization introduced with
`v4-b3a-bounded-receipt-export-source-serialization-authorization.md`.

It records two source-reality constraints found during lead falsification before
runtime implementation. It does not add a new product feature or widen the
runtime file scope.

## 1. SQLite durable row versus in-memory overlay

Current `Graph#getAuditEvents()` has backend-dependent behavior:

- without SQLite it filters `_auditEvents` in insertion order;
- with SQLite it loads every persisted audit row, then overlays `_auditEvents`
  by `auditId` in a `Map`, where the last in-memory duplicate wins, and finally
  sorts the merged result by `(timestamp, auditId)`.

For the normal public `appendAuditEvent()` path with SQLite enabled, the same
normalized event is appended to `_auditEvents` and synchronously inserted into
`audit_log`, so the two copies agree.

A conflicting duplicate `auditId`, however, can make the in-memory copy differ
from the already-persisted row because the SQLite write is `INSERT OR IGNORE`.
A streaming iterator cannot reproduce the current last-memory-wins global sort
for an arbitrarily conflicting overlay without either materializing/indexing the
whole overlay or changing authority semantics.

B3A therefore adopts the following fail-closed rule for its **new bounded
iterator only**:

```text
SQLite audit_log row = durable authority.
Same auditId in memory with identical normalized content = allowed duplicate.
Same auditId in memory with conflicting normalized content =
AUDIT_EVENT_SOURCE_DIVERGENCE / fail closed.
```

The bounded iterator must never silently choose the persisted value or the
in-memory value when they conflict.

This rule does not change existing `Graph#getAuditEvents()` behavior. It makes
the new B3A path stricter when durable and process-local evidence disagree.

Required additional acceptance evidence:

1. a normal SQLite `appendAuditEvent()` row whose in-memory and persisted copies
   agree is yielded once;
2. an exact duplicate does not duplicate a receipt;
3. a deliberately conflicting same-`auditId` memory overlay fails closed;
4. the failure occurs before any bundle is returned;
5. legacy `getAuditEvents()` remains unchanged by the implementation.

No attempt to repair, overwrite, delete or reconcile the conflicting audit row
is authorized.

## 2. What B3A means by bounded source read

B3A's required bounds are:

- at most 1025 unique receipt IDs retained while deciding the 1024 ceiling;
- no complete audit array materialization;
- one persisted `details` value materialized at a time and only after its byte
  length is within the hard ceiling;
- no individual JSON/canonical/hash serialization above the hard byte ceiling;
- no aggregate receipt array retained beyond the hard byte ceiling;
- no successful final bundle above the hard byte ceiling.

B3A does **not** claim constant-time lookup or a fixed maximum number of
historical audit rows visited. With the current schema there is no dedicated
receipt index, and sparse/duplicate receipt-bearing events may require a linear
streaming scan of the canonical workspace history before either completion or
the 1025th unique receipt is observed.

This is a deliberate non-claim, not permission to materialize the scan.

The implementation may reuse the existing
`idx_audit_workspace_timestamp` ordering/index support, but it may not add a
schema/index migration merely to manufacture an O(1) or fixed-row-scan claim.
If profiling later proves historical scan time is a product bottleneck, a
separate receipt-index/storage gate must authorize that optimization with its
own migration and compatibility evidence.

## 3. Oversized unrelated events

Because the source cannot know whether arbitrary `details` contains a valid
materialized receipt without inspecting it, an oversized event in the selected
canonical workspace is not silently skipped.

If its persisted `details` byte length exceeds the caller hard ceiling, the
bounded iterator fails closed before fetching/parsing the full value.

A large event outside the selected workspace must not affect canonical
`default` export because workspace filtering is applied in SQL before details
materialization.

This is intentionally conservative: B3A prefers an explicit blocked export to
silently omitting evidence from the canonical audit history.

## Runtime scope

Unchanged from the parent B3A task-pack:

```text
lib/json-utf8-size.js
lib/audit-log.js
graph.js
lib/receipt/receipt-read-index.js
package.json
test/v4-b3a-bounded-receipt-export-source.test.js
```

No seventh file is authorized.