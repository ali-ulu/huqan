# V4-B3 — Module Reachability Scope Amendment

## Status

`SCOPE_AMENDED_SEVENTH_FILE_AUTHORIZED`

Docs-only. This amendment authorizes exactly one additional implementation file
for V4-B3 and nothing else. No product decision, ceiling, status mapping,
forbidden-list entry or stop condition changes.

Controlling documents:

- `docs/task-packs/v4-b3-receipt-export-user-flow-authorization.md`
  (authorization artifact `7446642`, PR #524)
- `docs/task-packs/v4-b3-receipt-export-exact-base-reconciliation.md` (PR #582)

## Why an amendment is required

The controlling task-pack authorizes six implementation files and states:

> No seventh file is authorized. Any further owner is a stop condition and
> requires another source-backed scope amendment. If a conflicting assertion is
> found in an unlisted file, record the amendment explicitly rather than editing
> it silently — PR #520 set that precedent with `server.test.js`.

Implementing the six-file contract produces exactly such a conflicting
assertion. `test/module-reachability.test.js` fails on the exact head:

```text
not ok 2 - no acknowledgement is stale
  these files are listed as not-yet-wired but are now reachable (or gone).
  Remove them from NOT_YET_WIRED so the list keeps meaning something:
    lib/audit-bounded-read.js
    lib/json-utf8-size.js
    lib/receipt/bounded-receipt-export.js
```

This is the correct failure, not a regression. `lib/module-reachability.js`
carries a stale-acknowledgement invariant in both directions: a production file
unreachable from an entry point must be acknowledged, and an acknowledged file
that has become reachable must lose its acknowledgement, "so the list keeps
meaning something".

## Source-backed justification

The three entries were added by the V4-B3A scope amendment (PR #573) with
explicitly conditional wording, quoted verbatim from
`lib/module-reachability.js`:

```text
'lib/audit-bounded-read.js':
  'V4-B3A bounded audit source seam; intentionally unwired until separately
   authorized B3 user-flow wiring'
'lib/json-utf8-size.js':
  'V4-B3A helper for the unwired bounded receipt-export seam; no production
   caller until B3 wiring'
'lib/receipt/bounded-receipt-export.js':
  'V4-B3A bounded receipt-export seam; intentionally no production caller
   until B3 wiring'
```

Each acknowledgement names its own expiry condition: B3 user-flow wiring. B3 is
that wiring. `lib/workbench/receipt-bundle-exporter.js` requires
`lib/receipt/bounded-receipt-export.js`, which requires
`lib/audit-bounded-read.js`, which requires `lib/json-utf8-size.js`; the owner is
reached from `server.js` through `lib/workbench/workbench-read-http-router.js`.
All three are now genuinely reachable from a production entry point.

Removing them is therefore the discharge of a condition B3A wrote down in
advance, not a new judgement. Leaving them would assert in source that the
modules have no production caller while the same commit gives them one.

## Authorized additional file

```text
lib/module-reachability.js
```

The authorized change is exactly the deletion of the three
`NOT_YET_WIRED` entries quoted above, together with the
`--- V4-B3A bounded receipt source seam ---` section comment that introduces
them and becomes empty with them.

Explicitly not authorized by this amendment:

- no change to the reachability algorithm, traversal or entry-point list;
- no other `NOT_YET_WIRED` entry added, removed or reworded;
- no change to `test/module-reachability.test.js`;
- no eighth file.

The B3 authorized scope is therefore seven files: the original six plus
`lib/module-reachability.js`.

## Why not the alternatives

Two other ways to make the suite green were considered and rejected:

1. **Leave the modules unwired and re-implement bounded reading inside the B3
   owner.** This would duplicate the seam B3A was authorized to build, create a
   second export owner, and contradict the controlling task-pack's prohibition
   on defining a second receipt export path. It also reopens the exact
   unbounded-materialization risk that produced
   `V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP`.
2. **Require the seam lazily so the reachability scanner does not see it.**
   This would leave the acknowledgement technically true while making the
   published claim false in substance. It is the mirror of the move B3A already
   refused when it declined to wire modules into production purely to pass the
   gate, and it is dishonest for the same reason.

Deleting a discharged acknowledgement is the only option that keeps the source
statement and the runtime behaviour in agreement.

## Acceptance

Unchanged from the controlling task-pack, with two additions:

- `node --test test/module-reachability.test.js` passes on the exact head with
  no acknowledgement added, reworded or suppressed;
- the exact-head diff is the seven authorized files and no more.

The implementation candidate still finishes with exactly one verdict:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT
V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP
```
