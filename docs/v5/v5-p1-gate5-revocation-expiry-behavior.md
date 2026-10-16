# V5 P1 Gate 5 — Revocation / Expiry Runtime Behavior

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 5
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
implementation unit is a separate, single-purpose PR and is **not**
authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring, no changes to `lib/v5/trusted-key-resolver.js`. This document
changes exactly one file.

**Canonical base:** `main @ 39f71d3` (merge of PR `#898`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 What Gate 3 left for this gate, verbatim

`docs/v5/v5-p1-gate3-connector-boundary-policy.md` defines the four
credential lifecycle events and closes its own gate order with an
explicit handoff:

> "Gate 5 remains the runtime behaviour specification, and its
> successor must reconcile with the namespaces and event semantics
> defined here rather than re-define them."

Gate 3's event semantics, which Gate 5 inherits as fixed:

| Event | Gate 3 semantics |
|---|---|
| **Revoke** | Fail-closed, immediate in observation; after the revocation
  marker, every later evaluation returns `connector.revoked`; an
  unresolvable revocation record rejects whole. |
| **Expire** | Evaluated against `evaluationTime` on the receiver clock; a
  payload-supplied expiry is malformed (`connector.context_invalid`),
  never honoured. |
| **Rotate** | Replacement, not grant: a rotated credential inherits only
  the prior credential's bounded scope; the rotation record is
  unforgeable under the `FORBIDDEN_FIELDS` discipline. |
| **Compromised** | The strongest event: implicit revoke of the
  compromised credential plus a mandatory replay check over its
  lifetime (`replayed`/`persisted` receipt flags; replay owner is
  `lib/a2a/replay-store.js`, no second store). |

Gate 3 also fixes the namespaces — `connector.context_invalid`,
`connector.revoked` — and the no-fallthrough rule: a control family
must never degrade to a generic denial.

### 1.2 What the resolver already does (the as-is evidence)

`lib/v5/trusted-key-resolver.js` is the existing runtime precedent,
and Gate 5's spec is written to reconcile with it rather than replace
it:

- **Expiry is already receiver-clock evaluated**: `evaluationInstant =
  parseTimestamp(root.evaluationTime)` — the resolver takes its clock
  from the evaluation input, never the record, and `record.expiresAt
  <= evaluationInstant` yields the `expired` state. This is exactly
  Gate 3's and Gate 4's clock rule in live code.
- **Revocation is status-based**: a record whose `status` is
  `revoked` yields `REASONS.revoked_key` immediately; there is no
  `revokedAt` timestamp on the resolver's records, and the resolver
  is read-only — nothing writes a revocation record today.
- **Fail-closed states**: `unknown`, `unavailable`, and `malformed`
  all reject; an unresolvable root record (unknown key reference,
  duplicate match, forbidden content) never opens.
- **The resolver's expiry state is `expired`, not `revoked`** — a
  metadata-level distinction the resolver keeps, and Gate 5 must not
  collapse: an expired record that was never revoked is evidence of
  a different fact than a revoked one.

Two sibling mechanisms sit on the same concepts with different
mechanics, and Gate 5 must name the difference rather than ignore it:

- `lib/a2a/bounded-exchange.js` (identity plane) treats
  `revoked_at !== null || revocation_reason !== null` as **record
  invalidity** — a revoked identity record is refused at validation,
  not evaluated as a revocation event.
- `lib/external-client-authority.js` (V4 family) treats `revoked` as a
  **mandatory entry field** whose `true` value fails with
  `KEY_REVOKED` and whose non-`false` value fails as malformed.
- `lib/a2a/replay-store.js` provides the atomic reservation
  (`replayKey` → exclusive `wx`/`fsync` `.reserved` file, `EEXIST` →
  `reserved: false`) that the compromised-credential replay check
  borrows.

### 1.3 What this gate must reconcile

Three planes now carry revocation/expiry concepts, and this is the
first gate whose job is to make them agree on one runtime behaviour
without unifying their implementations:

1. The **identity plane** (resolver + exchange): the authority record
   owns the key's lifecycle state; evaluation answers "is this key
   usable now, for this action".
2. The **connector-credential plane** (Gate 3's events): connector
   credentials carry lifecycle events whose observation model Gate 3
   specified but whose runtime mechanics no code implements.
3. The **receipt plane**: every revocation and expiry decision must
   leave evidence linkable to a Trust Receipt, under the namespaces
   Gate 3 fixed — `identity.revoked_key`,
  `identity.expired_key_metadata`, `connector.revoked`,
  `connector.context_invalid`.

The reconciliation rule Gate 5 establishes: **the evaluation result is
a function of (record state, lifecycle event state, evaluation time),
evaluated at evaluation time, and never cached across it.** A decision
made at `t1` says nothing about `t2`; nothing in the resolver, the
exchange, or any future enforcement surface may hold a positive
judgment past the next evaluation.

## 2. The decision

Gate 5 writes the **runtime revocation/expiry behaviour** — how the
existing mechanisms must behave when lifecycle events occur — without
adding a revocation writer (that belongs to the resolver's own wiring
PR), without changing any namespace, and without choosing a hook
(Gate 2 keeps it).

### 2.1 Evaluation model

- Every lifecycle-bearing evaluation takes the same inputs in the same
  order as the threat model's predicate; revocation and expiry are
  checked as properties of the record against the receiver-owned
  `evaluationTime` — the resolver's existing `evaluationInstant`
  discipline is the canonical form.
- **Revocation outranks expiry**: a record that is both revoked and
  expired reports the revocation (`connector.revoked` /
  `identity.revoked_key`), because revocation is the stronger fact —
  expiry answers "was it still valid"; revocation answers "was it ever
  to be trusted again". The receipt must say which, so a consumer of
  the receipt can distinguish a key that lapsed from a key that was
  taken.
- **An unresolvable lifecycle state rejects whole**: if the
  revocation record cannot be located, read, or parsed, the
  evaluation returns the record's unresolvable reason
  (`key_lookup_unavailable`, `malformed_trusted_key_record`, or the
  equivalent namespace member), never a default-to-valid outcome and
  never silently downgrading to "not revoked".

### 2.2 Rotation and compromise

- **Rotation** is validated, not imported: the new credential's
  authority must resolve against the same resolver surface, its scope
  is the intersection of what it claims and what its predecessor held,
  and the rotation record's own integrity is checked under
  `FORBIDDEN_FIELDS` — key material in a rotation record makes the
  record malformed, never the credential invalid in a softer way.
- **Compromise** triggers the Gate 3 two-part behaviour: an implicit
  revoke of the compromised credential (same observation semantics as
  an explicit revoke — `connector.revoked` after the marker, immediate
  in observation) plus a mandatory replay check over the credential's
  known lifetime, using `lib/a2a/replay-store.js`'s reservation
  semantics — no second store, and a failed reservation
  (`REPLAY_RESERVATION_FAILED`'s analogue) rejects the evaluation
  rather than proceeding with reduced assurance.
- The compromise check observes receipts, it does not re-trust them:
  `replayed`/`persisted` flags describe what happened, and a
  replayed package with a compromised source key is reported, not
  re-judged.

### 2.3 Evidence

- Every revocation and expiry decision emits evidence under the
  namespaces Gate 3 fixed and the resolver's own reasons vocabulary
  preserves: `identity.revoked_key`,
  `identity.expired_key_metadata`, `connector.revoked`,
  `connector.context_invalid`. No new top-level namespace is
  introduced; sub-reasons grow under review.
- The evidence names the clock (`evaluationTime`), the record state,
  and the lifecycle event observed — a receipt that cannot reproduce
  its own judgment is a malformed receipt.

**Two deliberate non-decisions:**

- **No revocation writer.** The resolver stays read-only; writing a
  revocation record is its own wiring PR (the `#848` pack's unit).
  This gate only defines what evaluation must do *when* a record
  exists or fails to exist.
- **Hook location stays Gate 2's**, and this gate does not require
  revocation checks to run at any specific point — only that wherever
  they run, they use this evaluation model.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR whose subject
is the behaviour's *shape* as executable contract, not enforcement on
any path:

1. A bounded module (or equivalent home) implementing the evaluation
  model — record state, lifecycle event state, evaluation time — as
  pure, deterministic functions with no side effects, consistent with
  the writer kernel discipline of PR `#894`/`#895` and the Gate 3/4
  policy modules.
2. One conformance test set asserting: revoked outranks expired;
  unresolvable revocation record → reject whole (no default); rotation
  scope is an intersection; rotation records with forbidden content →
  malformed; compromise → revoked observation plus mandatory replay
  reservation (failure rejects); evidence names clock, state, event.
3. A compatibility assertion against
  `lib/v5/trusted-key-resolver.js`'s existing behaviour: the module's
  expiry and status-based revocation semantics match the resolver's
  receiver-clock and state results — the as-is evidence is preserved,
  not replaced.

**Forbidden:**

- any change to `lib/v5/trusted-key-resolver.js`, `lib/a2a/replay-store.js`
  beyond read-keys, the package schema, the receipt plane, the
  writer/reader kernels, `audit-log`, `ingest`, `storage.js` lookups,
  the A2A exchange, tracing, metrics, or logging semantics;
- a revocation writer, a registry table, an outbox, or a second key
  authority;
- a new top-level reason namespace;
- revocation outranked by, or collapsed into, expiry;
- any decision that defaults to valid when lifecycle state is
  unresolvable.

## 4. Acceptance preview (binding only in the implementation unit)

1. The module is pure: same inputs, same outputs, no side effects, no
   environment reads.
2. All six refusal paths have failing-on-violation conformance tests;
   refusal reasons read identically in conformance output and API
   response.
3. The resolver compatibility assertion passes — the as-is evidence
   (`expired` on receiver-clock expiry, `revoked` on status,
   fail-closed unknown/unavailable/malformed) is unchanged.
4. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`), module reachability, and the 4437-test suite stay
   green; no ledger graduation happens.

## 5. Invariants

1. Evaluation is a pure function of (record state, lifecycle event
   state, receiver clock) — never cached, never downgraded, never
   defaulted.
2. Revocation outranks expiry, and a receipt must say which event it
   observed; ambiguity between the two facts is the failure mode this
   gate exists to prevent.
3. One replay store (`lib/a2a/replay-store.js`), one key authority,
   one lifecycle vocabulary — the compromised-credential check borrows
   the existing reservation semantics without creating a parallel one.
4. Fail-closed in both directions: unresolvable lifecycle state
   rejects, and an evaluation that cannot complete its own lifecycle
   check rejects whole.
5. Observability adds no new authority; evidence records decisions, it
   never changes them.

## 6. Non-claims

This record does not claim that any revocation record can currently be
written; that the resolver's status-based revocation is adequate for
all lifecycle needs; that the identity plane's
`revoked_at`/`revocation_reason` mechanics and the resolver's
status-based revocation are one mechanism (they are different
mechanisms on the same concept, and this gate names the difference
without unifying it); that the external-client-authority's
`KEY_REVOKED` path is covered by this gate's semantics (it is V4
family evidence, recorded, not absorbed); or that this pack authorizes
enforcement.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [ ] Gate 2 — runtime hook location and fail-closed behavior
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (`v5-p1-gate4-workspace-delegation-policy.md`)
- [x] Gate 5 — revocation / expiry runtime behavior (this task pack, docs-only)
- [ ] Gate 6 — Trust Receipt linkage requirements
- [ ] Gate 7 — conformance fixtures for enforcement behavior
- [ ] Gate 8 — rollback and migration plan
