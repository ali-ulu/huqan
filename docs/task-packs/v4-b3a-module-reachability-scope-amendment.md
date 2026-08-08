# V4-B3A — Module-Reachability Scope Amendment

## Status

`BINDING_SCOPE_AMENDMENT_TO_V4_B3A_AUTHORIZATION`

Parent runtime issue: `#554`
Parent implementation PR: `#562`
Prior modularity amendment: `#560`

This amendment changes only the exact file scope required to satisfy the repository's existing module-reachability invariant. All V4-B3A product semantics, fail-closed rules, ceilings, durable-source rules, parity requirements, acceptance requirements and forbidden runtime behavior remain unchanged.

## Source-backed reason

PR #562 adds three intentionally unwired production modules:

```text
lib/audit-bounded-read.js
lib/json-utf8-size.js
lib/receipt/bounded-receipt-export.js
```

The repository already enforces `test/module-reachability.test.js`: every production module that is not statically reachable from a production entry point must either be a legitimate standalone/dynamic entry or be explicitly classified in `lib/module-reachability.js::NOT_YET_WIRED` with a reason.

B3A deliberately adds no HTTP route, CLI, MCP, UI or other production wiring. Therefore making these modules reachable would violate the B3A contract, while leaving them unclassified fails the repository's architecture gate. The minimum consistent repair is to acknowledge the three modules as intentionally not yet wired.

## Exact amended runtime scope

The B3A successor may now change exactly six files:

```text
lib/json-utf8-size.js
lib/audit-bounded-read.js
lib/receipt/bounded-receipt-export.js
lib/module-reachability.js
package.json
test/v4-b3a-bounded-receipt-export-source.test.js
```

The sixth file is authorized only for these three `NOT_YET_WIRED` acknowledgements:

```text
lib/audit-bounded-read.js
lib/json-utf8-size.js
lib/receipt/bounded-receipt-export.js
```

No entry-point wiring, production caller, route registration, dynamic loader change, reachability algorithm change, unrelated acknowledgement edit or cleanup is authorized.

## Required acknowledgement meaning

The reasons must make the lifecycle explicit:

- `lib/audit-bounded-read.js`: V4-B3A bounded audit source seam; intentionally library-only until the separately authorized B3 user-flow wiring.
- `lib/json-utf8-size.js`: V4-B3A helper used only by the unwired bounded receipt-export seam until B3 wiring.
- `lib/receipt/bounded-receipt-export.js`: V4-B3A bounded receipt-export seam; intentionally no production caller until B3 wiring.

These acknowledgements are temporary architecture classifications, not evidence that B3 is reachable or complete. They must become stale and be removed when a later authorized production path genuinely reaches the modules.

## Acceptance

The implementation PR must prove on its exact head:

1. the final diff is exactly the six authorized files;
2. `lib/module-reachability.js` changes only by adding the three acknowledgements above;
3. `test/module-reachability.test.js` passes without changing that test;
4. the three B3A modules remain unreachable from production entry points;
5. no HTTP route, server wiring, CLI, MCP, UI or V5 surface is added;
6. all prior B3A targeted/full-suite/CI requirements remain binding.

## Non-claims

This amendment does not authorize B3 production reachability and does not claim `V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT`, `V4 Workbench complete`, or any V5 completion state.
