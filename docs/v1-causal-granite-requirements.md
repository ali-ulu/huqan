# V1 Causal Granite — Requirements

- **Status:** Proposed
- **Date:** 2026-06-05
- **Owner:** AXIOM core team
- **Companion ADRs:** [ADR-V1-001](./adr/ADR-V1-001-causal-granite-architecture.md), [ADR-V1-002](./adr/ADR-V1-002-causal-edge-contract-and-future-fields.md), [ADR-V1-003](./adr/ADR-V1-003-traversal-semantics-depth-vs-cycle.md), [ADR-V1-004](./adr/ADR-V1-004-causal-verdict-trust-receipt-bridge.md), [ADR-V1-005](./adr/ADR-V1-005-causal-determinism-multiverse-test-strategy.md)
- **Scope:** V1 Causal Granite requirement list (R1–R6), scope-out, dependencies, and PR breakdown

## Goal

AXIOM's causal consistency kernel becomes deterministic, testable, and bound to
the Trust Receipt — without resurrecting the v0.7 causal runtime and without
weakening the v0.9.1 verification, memory, or provenance invariants.

## Requirements

### R1 — Future-proof causal edge schema

The causal edge contract must reserve room for `temporal`, `probability`, and
`formalProof` (and V6+ world-model fields) as `null` placeholders, with explicit
"doors, not implementations" semantics in V1. See
[ADR-V1-002](./adr/ADR-V1-002-causal-edge-contract-and-future-fields.md).

### R2 — Strict separation of `MAX_DEPTH_EXCEEDED` and `CYCLE_DETECTED`

Traversals must distinguish the two outcomes with separate verdicts, separate
receipt fields, and separate risk semantics. Depth-exceeded is a *warning*;
cycle-detected is a *hard stop* with a structural risk flag. See
[ADR-V1-003](./adr/ADR-V1-003-traversal-semantics-depth-vs-cycle.md).

### R3 — Deterministic traversal

A traversal, given the same `(graph snapshot, claim id, config)`, must visit
edges in the same order, hit the same termination condition, and report the same
`visitedEdgeCount`. Determinism is enforced by a multiverse CI test pack. See
[ADR-V1-005](./adr/ADR-V1-005-causal-determinism-multiverse-test-strategy.md).

### R4 — Compatibility with verify, semantic trust, provenance, and memory

V1 does not weaken any v0.9.1 invariant. Specifically:

- The `verify.status` contract (`dogrulandi / celiski / bilinmiyor`) is preserved.
- The `shouldLearn` invariant in `lib/shield.js` is preserved.
- The frozen schema sets (`MEMORY_SCHEMAS`, `AUDIT_EVENTS`, `CAUSAL_RELATIONS`,
  `MEMORY_STATUSES`, `MEMORY_EVENT_TYPES`, `MEMORY_LINK_RELATIONS`,
  `VALID_SOURCE_TYPES`, `TRUST_STATUSES`, frozen thresholds) are preserved.
- Provenance is mandatory on every causal edge.

### R5 — Causal verdict bound to Trust Receipt

Every causal verdict is attached to a Trust Receipt and a corresponding audit
event. The Trust Receipt carries an additive `causal` block. No new
`AUDIT_EVENTS` are introduced in V1. See
[ADR-V1-004](./adr/ADR-V1-004-causal-verdict-trust-receipt-bridge.md).

### R6 — Forward-compat placeholders are doors, not implementations

`temporal`, `probability`, `formalProof`, `worldModel`, `causalProjection`,
`counterfactualTrace`, and `simulationReceipt` are `null` in V1. They appear in
the schema to make future migration additive, but reading them as anything
other than `null` in V1 is a contract violation.

## Scope-Out (explicitly not in V1)

- Restoring any v0.7 causal runtime code.
- Runtime simulation / what-if execution / counterfactual planning.
- Probabilistic semantics over causal edges.
- Temporal semantics (event-time ordering, decay, "as-of" queries).
- Formal proof integration (Z3, Lean, Coq, etc.).
- World-model projection or simulation.
- External A2A agent marketplace (covered by the AX cross-cutting layer / V5).
- GitHub App / Streaming Trust runtime (covered by V4).
- Public marketplace of any kind (deferred to V5+).

## Dependencies (already in main, no V1 dependency work)

- v0.9.1 Memory Core (`lib/memory-store.js`, `lib/memory-store-utils.js`,
  `lib/memory-schema.js`).
- v0.9.1 Semantic Trust Gate (`lib/verify.js`, `lib/semantic-score.js`,
  `lib/semantic-signals.js`, `lib/claim-decomposition.js`,
  `lib/reasoning-trace.js`, `lib/risk-rules.js`, `lib/contradiction-rules.js`,
  `lib/text-utils.js`, `lib/shield.js`).
- v0.9.1 Trust Kernel (`lib/trust-policy.js`, `lib/provenance-ingest.js`,
  `lib/provenance-query.js`).
- v0.9.1 Trust Receipt path (`buildTrustReceipt` in `server.js`,
  `lib/provenance-query.js`).
- v0.9.1 Audit Log (`lib/audit-log.js`, frozen `AUDIT_EVENTS`).

## Invariants Carried Forward

1. `CONTRACT_VERSION = '1.0.0'` is preserved.
2. `shouldLearn = autoLearn && label !== 'unsupported' && label !== 'contradicted'`
   is preserved.
3. `verify.status ∈ { dogrulandi, celiski, bilinmiyor }` is preserved.
4. `risk.flags.circular_reasoning_risk` is the *only* risk flag introduced in V1.
5. No new `AUDIT_EVENTS` are introduced in V1.
6. Canonical graph mutation still requires the same review gates as any other
   memory write. Causal reasoning does not bypass review.

## Initial PR Breakdown

V1 is implemented as a series of small, scoped PRs. The first PR is V1-PR0 (this
docs-only ADR + requirements set). Subsequent PRs are listed for context only;
their exact file lists land with each PR.

| PR       | Title                                         | Type     |
| -------- | --------------------------------------------- | -------- |
| V1-PR0   | Causal Granite ADR + requirements             | docs     |
| V1-PR1   | Causal edge schema + runtime validators       | runtime  |
| V1-PR2   | Deterministic traversal + `MAX_DEPTH`/`CYCLE` | runtime  |
| V1-PR3   | Causal simulator v1 (skeleton)                | runtime  |
| V1-PR4   | Causal verdict aggregation                    | runtime  |
| V1-PR5   | Trust Receipt bridge                          | runtime  |
| V1-PR6   | Multiverse determinism test pack              | test     |
| V1-PR7   | Demo + docs + RC prep                         | docs     |

Each PR follows the AXIOM global PR discipline:

- One purpose per PR.
- OpenCode = implementer; Codex = reviewer / security gate; Human = final
  approver.
- Push and merge are separate, explicit approvals.
- Auto-merge is never permitted.
- Clean-clone full test + smoke is required before any release tag.

## Red Lines (cross-cutting)

- No auto-merge.
- No canonical graph mutation without review.
- No production memory write from the causal layer.
- No resurrection of v0.7 causal code.
- No new `AUDIT_EVENTS` in V1 (uses existing frozen set).
- No runtime semantics for `temporal`, `probability`, `formalProof`, or
  world-model placeholders in V1.
- No v0.9.1 frozen list mutation.
- No bump to `CONTRACT_VERSION` in V1 (it stays at `1.0.0`).

## V1-PR0 Deliverable (this PR)

V1-PR0 is **docs-only** and contains exactly six files:

1. `docs/adr/ADR-V1-001-causal-granite-architecture.md`
2. `docs/adr/ADR-V1-002-causal-edge-contract-and-future-fields.md`
3. `docs/adr/ADR-V1-003-traversal-semantics-depth-vs-cycle.md`
4. `docs/adr/ADR-V1-004-causal-verdict-trust-receipt-bridge.md`
5. `docs/adr/ADR-V1-005-causal-determinism-multiverse-test-strategy.md`
6. `docs/v1-causal-granite-requirements.md` (this file)

V1-PR0 contains **no** runtime code, **no** package changes, **no** server/UI
changes, and **no** test changes.
