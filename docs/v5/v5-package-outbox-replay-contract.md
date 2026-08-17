# V5 Package Transactional Outbox and Replay Contract

**Status:** `spec`

**Parent issue:** `#847` (P2, durable evidence plane) — child 6:
*"Transactional outbox and replay on the durable store."*

**Child issue:** none assigned yet; this document is the task pack. The
wiring PR is a separate, single-purpose unit and is **not** authorized
here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 37f8aea` (merge of PR `#894`). A successor
must re-verify its own exact SHA.

## 1. Source reality

Read from live source at the canonical base.

### 1.1 The V5 plane has no outbox family

A scan of every module under `lib/v5/` finds **no** outbox, idempotency,
replay, reservation, or sequence machinery. `runtime-writer` writes
nothing durable; the import route appends one audit event and answers;
export, registry, and reader surfaces remain `NOT_YET_WIRED`. There is,
consequently, nothing to replay today.

### 1.2 The durability family exists, in the V4 plane

The same concerns are already solved upstream — three examples govern
what "the same family" means in this codebase:

- `lib/external-client-authority.js` implements the **atomic replay
  pattern** end to end: a `replayStore` with an owner-required `reserve`
  method, a deterministic `replayKey(gate, createdAt, permission)`,
  `replayReserve`, and a hard `REPLAY_RESERVATION_FAILED` rejection —
  reserve-or-fail-closed, no silent overwrite.
- `lib/conflict-detector.js` marks every persisted mutation receipt with
  `replayed` / `persisted` flags, so a reader can tell a replayed record
  from a first write.
- `lib/approval-execution-evidence.js` carries `idempotentApprovalDecision`
  with `idempotent: true` meta — the idempotency declaration pattern.
- `storage.js` holds `checkpointId` (the subject of PR `#891`): the only
  existing recovery surface in the durability layer.

None of that machinery is V5's. This pack's job is to name the shape a
V5 durable package writer must expose when one is wired, so the wiring
PR inherits a contract instead of inventing vocabulary.

### 1.3 The blocking facts

A durable package store does not exist; the export and registry surfaces
that would consume it are blocked on the receiver-held card problem
(`#848`). An outbox contract therefore cannot be *satisfied* yet — it can
only be *shaped*, which is precisely what this child exists to do.

## 2. The decision

The durable unit of work stays the child-5 pair — **one (package record,
matching audit event)** — and this child adds two obligations on top,
both shaped after the V4 replay family, not invented anew:

- **Reserve-then-commit:** a durable writer must reserve the
  `(packageId, issuer)` slot **before** persisting the record, through a
  `reserve` method that fails closed (`RESERVATION_FAILED` vocabulary,
  mirroring `REPLAY_RESERVATION_FAILED`). A duplicate reserve is a
  rejection, never a silent overwrite — the idempotency discipline of
  `idempotentApprovalDecision` applies: same inputs, same outcome, never
  a second write.
- **Replay marking:** any record produced by replay (redelivery, crash
  recovery, `checkpointId`-based restore) carries a `replayed: true`
  flag, mirroring the conflict detector's receipt flags, so readers and
  audits can distinguish first writes from replays — and the atomicity
  invariant holds for replays exactly as for first writes (pair
  observable together or not at all).

**Where the seam sits:** outbox mechanics belong to the **caller seam**,
never the kernel. `runtime-writer` stays a deterministic, side-effect
free function (child 5's invariant); the outbox, reserve, and replay
flags live in whatever module hosts the durable writer — the same
boundary as the audit event. The wiring PR may choose the host module,
but not move machinery into the writer.

**Composition:** child 5 (atomicity) and child 6 (durability) compose as
*atomicity first, durability second*; neither assumes the other, and a
future unit must not merge them into one implementation blob.

## 3. What the wiring PR may do

**Allowed**, in exactly this order:

1. A bounded seam definition in one V5 caller module:
   `reserve({packageId, issuerKeyReference})` semantics, the two failure
   vocabularies (`RESERVATION_FAILED`, replay-specific where needed), and
   the `replayed` flag placement next to the stored record.
2. A test asserting: duplicate reserve rejects without writing; a
   replayed write carries `replayed: true`; the child-5 pair invariant
   holds across both first writes and replays.
3. A `checkpointId`-based recovery note linking to storage's existing
   `checkpointId` semantics (PR `#891`), if the durable writer is stored
   through storage — without modifying storage's lookup behavior.

**Forbidden:**

- any new outbox table, queue, or store in this unit — durability
  hosting decisions (sqlite, file, memory-replay) belong to a later
  durable-store unit with its own bounded PR;
- changes to `runtime-writer.js`, `runtime-reader.js`, `audit-log.js`,
  `ingest.js`, the receipt plane, schemas, export/GET surfaces, registry,
  revocation, health, tracing, metrics, logging, or `storage.js` lookups;
- the writer kernel gaining state, side effects, or idempotency logic;
- silent deduplication — duplicates reject, fail-closed;
- any claim that a replay flag implies re-verification — replayed
  packages keep their original verification outcome.

## 4. Acceptance preview (binding only in the wiring PR)

1. Duplicate reserve rejects with `RESERVATION_FAILED`; no durable trace
   is written on rejection.
2. A replayed write is observable with `replayed: true`; a first write
   never carries that flag.
3. The child-5 pair invariant is asserted across first writes and
   replays by a failing-on-violation test.
4. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`) and module reachability stay green.
5. No ledger graduation happens in the wiring PR.

## 5. Invariants

1. The writer kernel stays deterministic and side-effect free; outbox
   mechanics live at the caller seam, exactly as the audit event does.
2. Fail-closed: reserve-or-reject, replay-or-mark — never silent
   overwrite, never unmarked replay.
3. Replay does not re-trust: a replayed package's verification outcome
   is the original's; nothing about the replay flag grants provenance or
   authorization.
4. Existing wire formats, schemas, and the `NOT_YET_WIRED` ledger are not
   modified as a side effect.
5. This child closes `#847`'s evidence-plane surface: with children 1-6
  all documented, the durable evidence plane's *contracts* are complete;
  their satisfaction awaits real callers, out of pack scope.

## 6. Non-claims

This record does not claim that any outbox or replay implementation
exists in V5; that any durable package store is imminent; that
`checkpointId` will be used for package recovery; that the replay family
in `external-client-authority` will be shared across planes; or that
children 5 and 6 may ever be satisfied by the same module. It does not
authorize hosting decisions, storage formats, or queue semantics.

## 7. Unit order

- [x] child 1 — `#872` source-reality (closed)
- [x] child 2 — `#875` first production caller (closed; `#888` merged)
- [x] child 3 — Route Receipt write contract (closed via `#892`)
- [x] child 4 — immutable source snapshot contract (closed via `#893`)
- [x] child 5 — atomicity contract (closed via `#894`)
- [x] child 6 — this task pack (docs-only, this file)
