# V5 P1 Gate 7 — Conformance Fixtures for Enforcement Behavior

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 7
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
fixture unit — the PR that adds the enforcement behavior fixtures —
is a separate, single-purpose PR and is **not** authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests,
no fixture files, no pipeline changes. This document changes exactly
one file.

**Canonical base:** `main @ d7f6fbd` (merge of PR `#901`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 The machinery already exists, and the pack must not rebuild it

The repo's fixture/conformance pipeline is complete and tested, in the
order the closeout audit's chain records
(`V5-IMPL-1A` fixtures → `1B` schema → `1C` validator → `1D`
conformance linkage → `1E` coverage → `1F` readiness):

- **`schemas/v5/agent-identity-conformance.js`** exposes
  `runAgentIdentityConformance()` and
  `summarizeAgentIdentityConformance()` — it reads fixtures from a
  directory, validates each against the identity schema and validator,
  and compares outcomes against each fixture's own
  `expected_status`/`expected_reason_code`. The contract is strict in
  both directions: valid fixtures require
  `expected_status === 'valid'` with `expected_reason_code === null`
  and zero errors; invalid fixtures require one of
  `{invalid, revoked, expired, rejected}`, a non-null
  `expected_reason_code`, structured errors, and an error whose code
  matches the expected one.
- **`schemas/v5/agent-identity-coverage.js`** emits the
  `implementation_chain_coverage_manifest` — `countFixtures` sums
  total and valid counts, and its `NON_CLAIMS` list already records
  "Agent Identity is not runtime-enforced yet" among the six
  non-claims.
- **`schemas/v5/agent-identity-readiness.js`** emits the
  `agent_identity_readiness_index` with its `NOT_COMPLETED` map, whose
  `runtimeEnforcement: false` is the index's own statement that
  enforcement is not done.
- **`test/fixtures/v5/agent-identity/`** holds the six fixtures the
  conformance tests assert over — `valid.minimal.json`, and the
  invalid family covering `missing_agent_id`, `revoked_identity`,
  `expired_identity`, `workspace_mismatch`,
  `broken_delegation_chain`. `test/v5-agent-identity-conformance.test.js`
  asserts `results.length === 6` with summary checks;
  `test/v5-agent-identity-fixtures.test.js` asserts the fixture field
  set (agent_id through delegation_chain).
- Eleven sibling fixture directories exist
  (`a2a-trust-evidence`, `cryptographic-adapter`,
  `public-trust-receipt`, `runtime-reader`, `shared-trust-package`,
  `signed-content-binding`, `signing`, `trusted-key-resolver`,
  `trusted-key-resolver-binding`, `verification`), each covering its
  own plane.

Gate 7's work is therefore not infrastructure. It is the **fixture
specification**: which enforcement behaviors must have fixtures, what
each fixture must assert, and under which vocabulary — so the eventual
fixture PR adds behavior evidence without inventing any new mechanism.

### 1.2 What the closed gates hand to the fixture set

Every gate merged since the threat model now carries fixture-level
testable content, and that content is the spec's substance:

- **Threat model (Gate 1)** fixes the six namespaces and the
  no-fallthrough rule — fixtures are how a namespace is proven
  reachable in test form, and the no-fallthrough rule becomes the
  assertion that every invalid fixture carries a namespace member as
  its `expected_reason_code`, never a generic denial.
- **Gate 2** wrote the five criteria as evidence forms — criteria 3
  (fail-closed) and 5 (non-breaking) are directly fixture-testable:
  unresolvable identity must reject with a namespace reason, and the
  fixture PR must leave `v5-agent-identity-conformance.test.js` and
  `v5-agent-identity-fixtures.test.js` passing unchanged in CI.
- **Gate 3** fixed the four lifecycle events and their fail-closed
  observation semantics — fixtures for `revoked_identity` and
  `expired_identity` already exist; the spec extends the vocabulary to
  the full event set and the connector namespaces
  (`connector.context_invalid`, `connector.revoked`), whose fixture
  material lives in the sibling `trusted-key-resolver` directory and
  must be cross-referenced, not duplicated.
- **Gate 4** fixed workspace binding and delegation possession — the
  existing `workspace_mismatch` and `broken_delegation_chain`
  fixtures are the as-is evidence that the pipeline can carry these;
  the spec adds the delegation `scope_exceeded` case (possession
  subset) as a named fixture.
- **Gate 5** fixed revocation outranking expiry and unresolvable
  lifecycle state rejecting whole — a fixture whose lifecycle state is
  unresolvable must assert rejection of the whole decision, and a
  fixture exercising revocation-over-expiry must assert the revocation
  reason, not the expiry one.
- **Gate 6** fixed the five linkage properties and the reproduction
  sentence — the recomputation property is testable as a fixture
  class: a decision-evidence pair that recomputes to the same judgment
  and reason is conformant; a pair that diverges under the same
  deterministic rules must fail linkage with a detectable,
  namespace-bearing reason.

### 1.3 What must not change

The pipeline is the ground truth and the spec inherits it wholesale:
no new schema field, no new `expected_` field beyond the existing
`expected_status`/`expected_reason_code` pair, no change to
`runAgentIdentityConformance`/`summarizeAgentIdentityConformance`, no
coverage-manifest field growth, no readiness-index change. The
coverage manifest's `countFixtures` already counts any fixture added
under the directory discipline — that is the only growth mechanism
the spec authorizes. The `results.length === 6` assertion in the
conformance test is itself a ratchet: fixture count is controlled and
explicit, exactly the pattern the repo enforces for file sizes and
the `NOT_YET_WIRED` ledger.

## 2. The decision

Gate 7 writes the **fixture specification for enforcement behavior** —
the fixture classes, their expected-outcome rules, and the unit's
boundaries — without adding fixtures itself and without changing the
pipeline.

### 2.1 Fixture classes

Each fixture class maps to exactly one enforcement behavior and one
namespace member, so the fixture set is the threat model's vocabulary
in test form:

| Class | Behavior under test | Expected outcome |
| --- | --- | --- |
| `valid.minimal.*` | lawful identity, full evaluation | `valid`, `expected_reason_code: null` |
| `invalid.identity_claim.*` | malformed/unknown/absent claim | rejected, `identity.invalid_claim` |
| `invalid.workspace_mismatch.*` | decision bound to wrong workspace | rejected, `identity.workspace_binding_failed` |
| `invalid.delegation_scope_exceeded.*` | possessed but over-bounded scope | rejected, `delegation.scope_exceeded` |
| `invalid.delegation_chain.*` | unresolvable or broken chain | rejected, `delegation.chain_invalid` |
| `invalid.connector_context.*` | connector context fails | rejected, `connector.context_invalid` |
| `invalid.revoked.*` | observed revocation | rejected, `connector.revoked` |
| `invalid.unresolvable_lifecycle.*` | lifecycle state cannot be resolved | rejected whole, namespace reason; never "not revoked" |
| `invalid.revocation_over_expiry.*` | both events present | rejected for revocation, expiry reason absent |
| `valid.linkage_recomputation.*` | decision-evidence pair recomputes | conformant only if recomputation matches judgment and reason verbatim |
| `invalid.linkage_divergence.*` | same inputs, divergent output | fails linkage with detectable namespace reason; never generic denial |

The valid/invalid partition follows the pipeline's existing
`INVALID_EXPECTED_STATUSES` semantics; the `linkage_*` classes are
specified as fixtures carrying decision-plus-evidence material whose
conformance outcome is the reproduction property, not a schema
field.

### 2.2 The two hard rules

1. **No fallthrough, at fixture level**: every invalid fixture must
   name a namespace member as its `expected_reason_code` — the
   pipeline's `hasErrorCode` check is the mechanical enforcement, and
   the fixture spec's job is to make the set complete enough that a
   missing namespace has no fixture to fall back on.
2. **No default-to-valid, at fixture level**: unresolvable-input
   fixtures (`missing_agent_id` as-is, `unresolvable_lifecycle` as
   specified) must assert rejection; a fixture asserting acceptance of
   unresolvable identity is a spec bug, and the pipeline rejects such
   a fixture's `expected_status` by construction.

### 2.3 The fixture unit's boundaries

The successor unit — the PR that adds fixtures — is a **single bounded
PR** with narrow authority:

- It may add fixtures under `test/fixtures/v5/agent-identity/` only,
  one per specified class, following the existing naming discipline
  (`valid.*`/`invalid.*`), and it must bump the conformance test's
  `results.length` ratchet in the same commit with an explicit reason
  — the same discipline as any ratchet change in the repo.
- It may not change the schema, validator, conformance runner,
  coverage manifest, readiness index, or any sibling fixture
  directory; cross-plane material (connector events) is referenced by
  path from the sibling directory, never copied.
- It must leave every existing conformance and fixture test passing
  unchanged — Gate 2's criterion 5, asserted in CI on the same PR.
- It may not claim enforcement: fixtures are behavior evidence, not
  runtime behavior; the readiness index's `runtimeEnforcement: false`
  stays true until a runtime surface carries identity checks.

**Two deliberate non-decisions:**

- **Which invalid cases get fixtures first** — the class table is the
  spec; ordering within the unit is its own bounded decision.
- **The Gate 2 selection's surface-specific fixtures** — a chosen
  surface's entry-point fixtures follow the selection PR, under this
  spec's rules; Gate 7 does not pre-authorize any surface's fixtures.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR:

1. Fixture files under the directory discipline, covering the
   specified classes — one fixture per namespace member per §2.1
  table, each with schema-valid shape and the pipeline's required
   `expected_status`/`expected_reason_code` pair.
2. The `results.length` ratchet bump in the conformance test with an
   explicit reason, and no other change to that test's assertions.
3. CI green on the same PR: full conformance and fixture test suites
   passing unchanged except the count.

**Forbidden:**

- any change to the schema, validator, conformance runner, coverage
  manifest, readiness index, or sibling fixture directories;
- a new `expected_` field or schema field;
- copying connector-plane material into the agent-identity directory;
- asserting acceptance of any unresolvable identity;
- an enforcement claim — fixtures evidence behavior, they do not
  perform it;
- a fixture count bump without the ratchet-assertion change in the
  same commit.

## 4. Acceptance preview (binding only in the implementation unit)

1. Every invalid fixture names a namespace member as
   `expected_reason_code`; none asserts a generic denial; the
   pipeline's `hasErrorCode` check passes for each.
2. The `valid.minimal.*` and `valid.linkage_recomputation.*` fixtures
   assert `expected_status: 'valid'` with null reason code and zero
   errors.
3. The `unresolvable_lifecycle` and `revocation_over_expiry` fixtures
   assert rejection with the lifecycle-rule reasons, never the
   collapsed alternatives.
4. The conformance test's `results.length` ratchet is bumped
  explicitly; all other assertions unchanged; CI green on the same PR.
5. File-size, cycle, status-declaration, and acyclicity checks stay
  green; the coverage manifest's count grows by the natural
  `countFixtures` mechanism; the readiness index's
  `runtimeEnforcement: false` and non-claims stay true.

## 5. Invariants

1. Fixtures are the threat model's vocabulary in test form — one
   class per namespace member per behavior; a behavior without a
   class is not enforceable, and a class without a behavior is
   unreachable legacy.
2. The pipeline is the only growth mechanism: `countFixtures` counts
   what exists, the `results.length` ratchet controls additions, and
   the pipeline's outcome contract rejects both default-to-valid and
   fallthrough by construction.
3. Cross-plane material is referenced, never copied — connector
   lifecycle evidence stays in the resolver directory; identity
   fixtures point at it.
4. Fixture count growth is ratcheted like file-size growth: explicit,
   reviewable, and assertable in CI.
5. Evidence is not behavior: fixtures prove what the enforcement
   behavior *must* produce; they produce nothing at runtime.

## 6. Non-claims

This record does not claim that enforcement fixtures exist (the
fixture unit adds them); that the readiness index's
`runtimeEnforcement: false` has changed; that this pack modifies the
schema, validator, conformance runner, coverage manifest, readiness
index, or any sibling fixture directory; that fixture addition
implies enforcement; or that any surface's fixtures are pre-authorized
— the selection PR keeps that authority, under this spec's rules.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [x] Gate 2 — runtime hook location and fail-closed behavior (`v5-p1-gate2-runtime-hook-location.md`)
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (`v5-p1-gate4-workspace-delegation-policy.md`)
- [x] Gate 5 — revocation / expiry runtime behavior (`v5-p1-gate5-revocation-expiry-behavior.md`)
- [x] Gate 6 — Trust Receipt linkage requirements (`v5-p1-gate6-trust-receipt-linkage.md`)
- [x] Gate 7 — conformance fixtures for enforcement behavior (this task pack, docs-only)
- [ ] Gate 8 — rollback and migration plan
