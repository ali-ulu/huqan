# V5 P1 Gate 8 — Rollback and Migration Plan

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 8
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
migration unit — the PR sequence that executes a migration step under
this plan — is a separate, single-purpose sequence and is **not**
authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests,
no migration code, no artifact changes. This document changes exactly
one file.

**Canonical base:** `main @ 33a8465` (merge of PR `#902`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 The repo already has a migration discipline, and Gate 8 extends it rather than inventing one

The strongest as-is evidence is the merged D7 closeout
(`v5-d7-htp-atp-migration-compatibility-closeout.md`), which closed
the HTP/ATP migration compatibility question with an **immutable
migration rule**:

> ATP 0.1 receipt and bundle schema versions are immutable and remain
> readable. AXIOM package 0.1 remains a valid input format. A
> canonical write creates a new HUQAN package 0.2 envelope; it does
> not mutate the supplied legacy package or rewrite an artifact in
> place. Embedded object semantics remain version 0.1. Legacy and
> canonical discriminator fields cannot be combined. Ambiguous input
> is rejected rather than normalized by precedence.

The D7 lineage is itself immutable and documented — PR `#635`'s base,
head, merge, and tree SHAs are recorded, and the closeout states the
change set "did not alter the retained ATP 0.1 receipt/spec tree,
AXIOM package 0.1 fixtures, or Receipt Trust Root historical
fixtures." Gate 8's plan inherits that rule wholesale and generalizes
it: **canonical write is a new artifact, never an in-place rewrite;
ambiguous input rejects rather than normalizes; legacy paths remain
shipped.**

### 1.2 The mechanisms a migration can stand on

Four mechanisms in live source are the plan's standing ground, none
of which this pack may change:

- **`POLICY_VERSION` is a single, constant version surface** —
  `lib/action-risk-classifier.js` pins `const POLICY_VERSION =
  'AB1-v2.0.0'` and every decision record carries it. Policy-version
  migration, should it ever be needed, would be a single-point change
  with a single-point revert; there is no scattered version state.
- **Checkpoints exist as a storage primitive** — `storage.js`'s
  `checkpoints` table (goal_key, workspace_id, status, resumed) is the
  repo's existing resumable-work marker; the plan must not confuse it
  with transactional rollback, but it may require migration units to
  record progress through it where the unit's work is long-running.
- **The idempotency discipline is an as-pattern** — the outbox/replay
  contract (`v5-package-outbox-replay-contract.md`) recorded the
  `idempotentApprovalDecision` declaration pattern and the rule that
  replays record rejection, never silent overwrite. A migration replay
  (Gate 6's child-6 pattern) must carry the same declaration.
- **Reproducibility binds packages to source** — the immutable source
  snapshot contract (`v5-immutable-source-snapshot-contract.md`)
  fixes the package-to-source hash/version binding; any migrated or
  migrated-from artifact must recompute to its declared source state.

### 1.3 What the closed gates hand to the plan

The plan is sequenced against what the seven closed gates proved and
what the remaining units must do:

- **Gate 7's unit** wires the conformance fixtures — the first
  runtime-visible step on this chain, and the one the closeout's
  transition condition already ordered (V5-IMPL-2A starts with Shared
  Trust Package fixture/schema work, *not* runtime enforcement).
- **Gate 2's unit** selects one surface and adds one read-only
  fail-closed check point — the first enforcement-visible step; its
  wiring must be reversible by removing the check point with no other
  change.
- **Gates 3–5** carry the connector/lifecycle vocabulary — their
  enforcement units must each be independently reversible (one
  boundary, one event semantic, one behavior each).
- **Gate 6's unit** wires linkage — its tests must pass both before
  and after any rollback, because linkage assertions are assertions
  about deterministic recomputation.
- **The readiness index stays the plan's status instrument** —
  `runtimeEnforcement: false` is the plan's definition of "migration
  not yet crossed"; it flips only when a surface carries identity
  checks, and only a unit may flip it, never prose.

### 1.4 What does not exist, and must not be claimed

No data migration from V4 ingest records to V5 evidence-plane records
exists or is authorized by this plan: writers write new-format
artifacts; historical artifacts stay immutable and readable (D7's
rule). No production deployment is part of this chain — the repo-only
tarball smoke rule (`4C1`-style checks) is the deployment boundary,
and a migration step that fails the tarball smoke does not reach
anything real. No rollback *mechanism* is written by this pack: the
mechanisms are git revert, the tarball smoke, the conformance suite,
and the D7 immutable-write rule — all existing; the plan orders and
asserts them.

## 2. The decision

Gate 8 writes the **rollback and migration plan** — the migration
lines, their sequence against the closed gates, the per-step rollback
contract, and the unit's boundaries — without executing any migration
step.

### 2.1 The two migration lines

| Line | Content | First step | Rollback instrument |
| --- | --- | --- | --- |
| A — evidence plane | V5 writer/reader ingestion from V4 families; package/source snapshot binding (child 4); atomicity (child 5); outbox/replay (child 6) | already in progress as separate, merged task packs; remaining steps follow their own packs | git revert + tarball smoke + conformance suite unchanged |
| B — enforcement chain | Gate 7 fixtures → Gate 2 selection + one check point → Gates 3–5 vocabulary/lifecycle units → Gate 6 linkage wiring | Gate 7's unit (the immediate successor) | each unit's step reversible in isolation: remove the added code, revert the ratchet change, suite unchanged |

Line B is the chain this gate governs; line A is carried by the
already-merged child packs and needs only the general rule, not a new
plan. The plan's authority over line A is the immutable-write rule;
its authority over line B is the step contract of §2.2.

### 2.2 The per-step rollback contract

Every migration step — one step per unit, never a combined step —
must satisfy five assertions, each checkable in CI on the unit's own
PR:

1. **Isolation**: the step adds exactly what its pack authorizes
   (Gate 7: fixtures + ratchet bump; Gate 2's successor: one check
   point + reachability proof; and so on) and touches nothing else;
   reverting the step removes all of it and only it.
2. **Suite invariance**: the step leaves the full suite — 4437 tests
   and growing — passing unchanged; a regression is a step failure,
   not a suite problem.
3. **Immutable writes**: the step never rewrites an existing
   artifact, package, receipt, or fixture; canonical writes are new
   artifacts (D7's rule), ambiguous input rejects.
4. **Reproducibility**: every artifact the step produces recomputes
   to its declared source snapshot and policy version
   (`AB1-v2.0.0`'s successors, if any, single-point and revertible).
5. **Status truth**: the readiness index and coverage manifest
   reflect the step's outcome exactly — no claim before the step is
   merged and smoked; the closeout's forbidden claims
   ("runtime enforcement exists", "V5 is complete") stay forbidden
   until their specific units cross.

### 2.3 The migration unit's boundaries

The successor units execute steps under this plan; the plan itself
does not:

- **Allowed** for each unit: one bounded PR per §2.1 step, with the
  five §2.2 assertions green on that PR; the D7 immutable-write rule
  applied to anything the step writes; the idempotency declaration
  pattern for any replay material.
- **Forbidden** for every unit: a step that mutates historical
  artifacts; a step that combines two lines' material; a step whose
  revert is not a clean `git revert` (no intertwined changes, no
  shared data-format changes between steps); a step that claims
  readiness the index does not carry; and a migration that touches
  production — the plan ends at the tarball smoke boundary.

**Two deliberate non-decisions:**

- **When line B starts beyond Gate 7's unit** — ordering is fixed
  (§2.1), but scheduling follows the consumer-driven discipline
  already applied to #845: a step starts when its named successor is
  ready, not when the plan says so.
- **The enforcement chain's production crossing** — the plan's
  boundary is the repo; production deployment is outside this chain's
  authority (as #279's beta track and the connector inventory's
  non-wired status already record).

## 3. What the implementation units may do

**Allowed**, per unit, in the §2.1 order:

1. Gate 7's unit: fixtures + ratchet bump (already specified by Gate
   7; Gate 8 adds only the rollback assertions).
2. Gate 2's successor: the selection + one check point; reversible by
   removing the check point and restoring the ratchet.
3. Gates 3–5's successors: one vocabulary unit each; each reversible
   in isolation.
4. Gate 6's successor: linkage wiring; tests pass before and after
   rollback.

**Forbidden** (applies to all): artifact rewrites, ambiguous-input
normalization, cross-line steps, steps not revertible by clean
revert, production touching, readiness claims without index evidence.

## 4. Acceptance preview (binding only in the implementation units)

1. Each step's PR carries the five §2.2 assertions green — suite
   unchanged, no artifact mutation, reproducible outputs, truthful
   status.
2. A clean `git revert` of any step's merge leaves the repo in the
   exact pre-step state, re-verified by the same CI.
3. The readiness index's `runtimeEnforcement: false` and the closeout's
   forbidden claims hold until their specific units cross; the
   transition condition (V5-IMPL-2A starts with fixture/schema work)
   is honored.
4. D7's immutable-write rule holds for every artifact any step
   writes; legacy paths remain shipped.

## 5. Invariants

1. Migration is a sequence of single-purpose steps, each with its own
   rollback — never one combined migration, because a combined step
   cannot be reverted cleanly and is therefore not a migration.
2. The only write rule is D7's: canonical writes create new
   artifacts; historical artifacts are immutable and readable;
   ambiguous input rejects.
3. Reversibility is a CI assertion, not a hope: a step whose revert
   is not clean is a failed step, however green its forward run.
4. Status claims follow evidence: the readiness index and coverage
   manifest are the plan's source of truth; prose cannot promote a
   status.
5. The plan ends where the repo-only boundary begins: no step may
   claim production crossing, and the tarball smoke is the plan's
   outer wall.

## 6. Non-claims

This record does not claim that any migration step has been executed;
that any rollback mechanism was written by this pack; that V4 records
are migrated to V5 format (writers write new artifacts; historical
artifacts stay immutable); that any step is scheduled beyond Gate 7's
unit (scheduling follows the consumer-driven discipline); that the
enforcement chain may cross into production; or that the readiness
index's `runtimeEnforcement: false` will change on any timeline.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [x] Gate 2 — runtime hook location and fail-closed behavior (`v5-p1-gate2-runtime-hook-location.md`)
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (`v5-p1-gate4-workspace-delegation-policy.md`)
- [x] Gate 5 — revocation / expiry runtime behavior (`v5-p1-gate5-revocation-expiry-behavior.md`)
- [x] Gate 6 — Trust Receipt linkage requirements (`v5-p1-gate6-trust-receipt-linkage.md`)
- [x] Gate 7 — conformance fixtures for enforcement behavior (`v5-p1-gate7-conformance-fixtures.md`)
- [x] Gate 8 — rollback and migration plan (this task pack, docs-only)
