# V5 Package Atomicity — Write + Audit as One Observable Unit

**Status:** `spec`

**Parent issue:** `#847` (P2, durable evidence plane) — child 5:
*"Atomicity between graph mutation and audit/receipt emission."*

**Child issue:** none assigned yet; this document is the task pack. The
wiring PR is a separate, single-purpose unit and is **not** authorized
here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 2f14b48` (merge of PR `#893`). A successor
must re-verify its own exact SHA.

## 1. Source reality

Read from live source at the canonical base.

### 1.1 The writer is not a persistence layer

`lib/v5/runtime-writer.js::writeRuntimePackage` (lines 267-278) validates
input and returns the built package object — it writes to no memory or
durable store. **There is currently no graph mutation, no package store,
and therefore no in-flight atomicity problem at the writer seam.** This
pack must not pretend one exists; its subject is the unit-of-work
discipline that must hold *when* a persistence caller is wired.

### 1.2 The only production write path is one call chain

`lib/http/v5-package-import-route.js` is the single production caller of
`writeRuntimePackage`. Its observed order is: (a) writer produces the
package object, (b) `appendAuditEvent([], auditEvent)` records
`v5_package_imported` **after** the write succeeds, (c) the 200 response
is written. Two observable failure modes already live in that chain:

- the writer rejects (returns `ok !== true`) → no audit event, 400. This
  half is already fail-closed.
- `appendAuditEvent` throws on an unsupported target
  (`lib/audit-log.js:83-93`) or on a post-append failure; the write is
  durable (in the array target) but the response never arrives — a
  partial-visibility case. Its reverse is also possible: event appended,
  response JSON write fails → the audit record exists while the caller
  sees only an error.

Neither case is a silent lost write; both are *observed* failures with a
trace. The contract this child installs is that this remains true after
storage wiring, and that a future reader can never observe a record of a
write without the matching audit event, or vice versa.

### 1.3 What "graph mutation" means here

The V5 evidence plane has no graph mutation today — the deterministic
mutation surface the parent issue names (`#847`'s wording) is prospective.
This pack therefore defines atomicity over the two surfaces that will
exist in sequence: **(1) the package record**, **(2) the matching
`v5_package_imported` audit event**. When a real mutation seam appears,
this contract's unit-of-work rule extends to it without re-authorization;
authorizing that extension is out of scope and needs its own pack.

## 2. The decision

The unit of work is **one (package record, audit event) pair**, and the
observable invariant is:

> A package record is observable if and only if the matching audit event
> is observable. No durable trace of a package exists without its event,
> and no event exists without its package record.

Concretely for the wiring PR:

- **Write-then-audit ordering**: the audit event is appended only after
  the package record write returns success, and never re-ordered or
  elided to "speed up" the response.
- **Failure atomicity (fail-closed)**: any throw between writer success
  and a successful response → the record must **not** remain observable
  by any future reader. With the current in-memory storage, this means
  rollback of the write on failure; with a durable store later, it means
  the write participates in the store's transaction or outbox contract
  (child 6), never a bare write followed by a hoped-for event.
- **Single emission seam**: exactly one route emits
  `v5_package_imported`. No other module may append that event type, and
  no other event type may stand in for it. The wiring PR asserts this by
  a test that only the route can produce the pair.
- **No response-masking**: a 200 response is written only when both the
  record and the event are durably committed. A caller must never be told
  success for a half-written unit.

## 3. What the wiring PR may do

**Allowed**, in exactly this order:

1. A unit test asserting the current invariant by observation: with the
   writer given an input that throws mid-chain (via the audit target),
   no `v5_package_imported` event remains in the target; and a successful
   write always leaves exactly one matching event. Tests fail on
   violation — this is the acceptance test for the future wiring too.
2. `lib/http/v5-package-import-route.js` — guard the response behind a
   commit check: 200 only when both halves are committed; on a failure
   after the write, the in-memory record is removed (rollback), and the
   error propagates as a 5xx with the existing rejection vocabulary.
3. A new bounded constant area in the route module naming the
   unit-of-work type (`v5-package-import`) so future seams (child 6, a
   real mutation seam) key off the same invariant name, not per-seam
   vocabulary.

**Forbidden:**

- any change to `lib/v5/runtime-writer.js` shapes or `buildPackage` —
  the writer stays deterministic and side-effect free; side effects
  belong to the caller, never the kernel;
- any change to `lib/audit-log.js`, `lib/ingest.js`, the receipt plane,
  export/GET surfaces, persistence layout, registry, revocation, health,
  tracing, metrics, logging, or the package schema;
- transactions, outbox tables, or durable-store changes (child 6's
  subject — this pack deliberately does not reach them);
- re-ordering so the event precedes the record write;
- any claim that a matching event proves the package was signed,
  authorized, or verified beyond the existing bounded checks — the event
  proves the write completed, nothing more.

## 4. Acceptance preview (binding only in the wiring PR)

1. New unit test passes: throw mid-chain leaves no event; success leaves
   exactly one matching event; the pair is observable together or not at
   all.
2. Existing 200/400 semantics unchanged on the happy path; only the
   previously-untestable half-visible failure cases gain observed
   rollback.
3. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits.
4. Tarball smoke tests (`4C1`) stay green; the route's lazy V5 require is
   untouched.
5. `node --test test/module-reachability.test.js` stays green; no ledger
   graduation happens in the wiring PR.

## 5. Invariants

1. The writer remains a pure function; atomicity discipline lives in the
   caller seam, exactly like the fail-closed policy itself.
2. Fail-closed extends to visibility: a half-written unit is more
   dangerous than a fully failed one, because the half can be read as a
   whole. The wiring PR's rollback test closes that window.
3. This pack's unit-of-work rule is a *contract*, not a durability
   guarantee — durability is child 6's (transactional outbox and replay).
   The two children compose: atomicity first, durability second; neither
   is assumed by the other.
4. Existing wire formats, schemas, and the `NOT_YET_WIRED` ledger are not
   modified as a side effect.

## 6. Non-claims

This record does not claim that any package record has ever been
durable; that a graph mutation seam exists or is imminent; that
`appendAuditEvent` is transactional; that a failure after the 200 write
is impossible; or that the current in-memory behavior is sufficient for
production deployment. It also does not claim the writer throws — it is
deterministic; the failure cases this pack governs live in the caller's
seam.

## 7. Unit order

- [x] child 1 — `#872` source-reality (closed)
- [x] child 2 — `#875` first production caller (closed; `#888` merged)
- [x] child 3 — Route Receipt write contract (closed via `#892`)
- [x] child 4 — immutable source snapshot contract (closed via `#893`)
- [x] child 5 — this task pack (docs-only, this file)
- [ ] child 6 — transactional outbox and replay on the durable store
