# V5 Route Receipt — Real Write Contract

**Status:** `spec`

**Parent issue:** `#847` (P2, durable evidence plane) — child 3: *"Route Receipt
real write contract — a bounded write path, not a projection."*

**Child issue:** none assigned yet; this document is the task pack. The wiring
PR is a separate, single-purpose unit and is **not** authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 6d42dd5` (the merge of PR `#891`, 4437-pass test
suite). A successor must re-verify its own exact SHA; every factual claim
below is checkable by grep at that base.

## 1. Source reality

Read from live source at the canonical base. Three documents already define
route receipt shapes, and a library writer already accepts route receipt
material — but they do not agree on what a route receipt **is**.

### 1.1 The validator knows two shapes

`lib/v5/shared-trust-package-validator.js` validates two distinct shapes:

| Shape | Location | Required fields | Validator checks |
|---|---|---|---|
| `receipt.routeReceipt` | inside the `receipt` object | `routeId` (non-empty string), `hopCount` (non-negative integer), `metadata` (non-empty object, string/number/boolean/null values) | exact key set `{routeId, hopCount, metadata}`; per-metadata value type; `route_receipt` packages require it (`#255-256`) |
| `routeReceipt` | top-level | `routeId` (non-empty string), `hops` (non-empty array) | exact key set `{routeId, hops}`; each hop validated at `routeReceipt.hops[i]` |

The package schema (`schemas/v5/shared-trust-package.schema.json`) mirrors the
`receipt.routeReceipt` shape: `required: ["routeId", "hopCount"]` with a
`metadata` property allowing additional primitives. The conformance matrix
(`schemas/v5/shared-trust-package-conformance-matrix.json`, area
`route_receipt_metadata`, status `covered`) ties both shapes to the format
document `docs/v5/v5-shared-trust-package-format.md` and reserves the future
gate "cross-agent route verification" with `runtimeClaimAllowed: false`.

### 1.2 The writer knows a third shape

`lib/v5/runtime-writer.js::validateRouteReceipt` accepts an input shape that
matches **neither** validator shape:

- `routeId` (non-empty string) — shared with both validator shapes;
- `decisionPath` (array of non-empty strings) — **unknown** to the validator;
- `optional handoff` (`{from, to}`) — **unknown** to the validator;
- **no `hopCount`, no `metadata`, no `hops`.**

Because the validator enforces exact key sets, **a package the writer accepts
with a routeReceipt today fails schema validation**: `decisionPath`/`handoff`
are additional properties, and `hopCount`/`metadata` are missing. The two
halves of the evidence plane cannot currently exchange a route receipt.

### 1.3 The production caller writes none

`lib/http/v5-package-import-route.js` never supplies a route receipt — the
import route's `reason_category` can never be
`valid_route_receipt_metadata`. The writer's own contract test
(`test/v5-runtime-writer-reader-local-contract.test.js`) round-trips packages,
but no test asserts that a writer-produced package with route receipt
material survives the validator.

## 2. The decision

The bounded write contract this unit authorizes for a later wiring PR is
**one shape only**: `receipt.routeReceipt` with `routeId`, `hopCount`,
`metadata`.

- The validator's shape is already `covered` by the conformance matrix,
  already fixed by the schema, and already tested. The writer's and the
  top-level shapes add ambiguity without any production consumer. Picking
  one shape, the one the validator already enforces, is the minimum change
  that makes a real route receipt writable at all.
- `hopCount` is authoritative from the route's own claim, carried by the
  **receiver of the route**, never self-inflated by the writer: the writer
  must reject `hopCount` greater than the route's observed decision length
  (the wiring PR defines the bound; this pack does not). `metadata` carries
  route-private tags only; nothing in it may name an agent identity or
  trust root (that material belongs to the receipt, registry, or evidence
  plane).

## 3. What the wiring PR may do

**Allowed**, in exactly this order:

1. `lib/v5/runtime-writer.js` — one change: `validateRouteReceipt` and
   `buildPackage` must produce the validator's `receipt.routeReceipt` shape
   (`routeId`, `hopCount`, `metadata`, exact key set). Everything else the
   writer does (verdicts, claims, provenance) stays untouched. This is a
   schema-convergence fix inside the same bounded module, not a new surface.
2. `lib/http/v5-package-import-route.js` — may accept an optional bounded
   `routeReceipt` input and forward it to the writer, applying the same
   fail-closed admission chain as the rest of the route. If it emits one,
   the response's `reason_category` may be `valid_route_receipt_metadata`.
3. One test file asserting the convergence: a writer-produced package with
   route receipt material passes the validator; malformed/over-bounded
   `hopCount` is rejected; absent input leaves `routeReceipt` out (writer
   already behaves so, and the test must keep it that way).

**Forbidden:**

- any change to the validator, the schema, the conformance matrix, or the
  format document — the shape is decided, and reopening it here is not this
  unit's authority;
- the top-level `routeReceipt` shape or the writer's `decisionPath`/`handoff`
  fields — they become unreachable legacy the moment the PR lands; removing
  them is a separate cosmetic unit, out of scope;
- any `NOT_YET_WIRED` ledger change (graduation follows a proven real
  caller, not a shape fix);
- persistence changes, `POST /api/v5/packages` body semantics beyond the
  single optional field, `GET` or export surfaces, discovery, registry,
  revocation, health, tracing, metrics, logging, or any V4 wire-format
  touch;
- any claim that a written route receipt implies cross-agent verification —
  the conformance matrix's future gate stays future.

## 4. Acceptance preview (binding only in the wiring PR)

1. `node scripts/check-file-size.js` and `node scripts/check-import-cycles.js`
   stay green; `lib/v5/runtime-writer.js` stays under 800 lines (the
   convergence shrinks the writer's input code; the limit must still be
   checked at the PR's base).
2. The writer's own fixture and local-contract tests stay green; no existing
   package (with or without receipt material) changes its written output
   shape except the formerly-unwritable route receipt field.
3. A new round-trip convergence test: write with route receipt → validator
   passes; write with malformed/over-bounded hopCount → writer rejects;
   import route supplies the field → package carries it; import route omits
   it → package omits it.
4. Tarball smoke tests (`4C1`) stay green — the route's V5 require stays
   lazy and conditional.

## 5. Invariants

1. A module graduates off `NOT_YET_WIRED` only by acquiring a real caller —
   this unit fixes the shape a real caller can write; it does not graduate
   anything.
2. Fail-closed: any route receipt input the writer cannot validate is
   rejected whole; no partial receipt is ever emitted.
3. The route receipt is route evidence, not agent identity: it may not name,
   imply, or leak an agent identity, trust root, or key material.
4. Existing V4 receipt and package wire formats are not modified as a side
   effect.

## 6. Non-claims

This record does not claim that any route receipt has been written in
production; that `hopCount` has an authoritative definition beyond the
validator's type contract; that the top-level shape or `decisionPath`/
`handoff` were ever used by anyone; or that cross-agent route verification
exists or is imminent.

## 7. Unit order

- [x] child 1 — `#872` source-reality (closed)
- [x] child 2 — `#875` first production caller (closed; `#888` merged)
- [x] child 3 — this task pack (docs-only, this file)
- [ ] child 4 — immutable source snapshot with hash + version
- [ ] child 5 — atomicity between graph mutation and receipt emission
- [ ] child 6 — transactional outbox and replay on the durable store

The reader side of export stays out, with the registry's receiver-held-card
blocker; it joins when its own bounded unit opens.
