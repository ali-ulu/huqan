# ADR-V1-003 — Traversal Semantics: Depth vs Cycle

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** AXIOM core team
- **Supersedes:** —
- **Cross-references:** [ADR-V1-001](./ADR-V1-001-causal-granite-architecture.md), [ADR-V1-002](./ADR-V1-002-causal-edge-contract-and-future-fields.md), [ADR-V1-004](./ADR-V1-004-causal-verdict-trust-receipt-bridge.md), [ADR-V1-005](./ADR-V1-005-causal-determinism-multiverse-test-strategy.md)
- **Scope:** V1 causal traversal semantics; distinct outcomes for depth limit and cycle detection

## Context

A causal traversal that walks the graph from a given claim must terminate in bounded
time and produce a stable, deterministic result. Two termination conditions look
similar but carry very different operational meaning:

- Hitting a depth limit is a *resource* condition. The traversal has not necessarily
  found a problem; it has simply been cut short. The remaining graph may still be
  safe, and a re-run with a higher limit could yield a different verdict.
- Hitting a cycle is a *structural* condition. The graph contains a loop in the
  causal relation, which is a substantive signal about the claim set. A re-run with
  a different limit will not change the structural fact.

Conflating these conditions hides important information from the operator and from
the Trust Receipt. V1 Causal Granite must distinguish them explicitly.

## Decision

V1 causal traversal recognizes **two distinct termination conditions** for partial
traversals:

### 1. `MAX_DEPTH_EXCEEDED`

- **Meaning:** Traversal reached the configured `MAX_DEPTH` (proposed default: `32`,
  finalized in V1-PR2) without exhausting reachable edges in the visited frontier.
- **Operational reading:** *Partial traversal.* The traversal completed for the
  reachable depth budget and stopped cleanly at the limit.
- **Verdict effect:** `depth_incomplete` (see ADR-V1-004). Trust Receipt records a
  *warning*, not a risk flag.
- **Confidence effect:** A confidence *penalty* is applied (proposed: `−0.1`,
  finalized in V1-PR2). The penalty is bounded and is documented in the receipt.
- **Risk flag effect:** `risk.flags.circular_reasoning_risk` is **not** set.
- **Receipt field:** `traversal.stopReason = "depth_exceeded"`,
  `traversal.completed = false`, `traversal.visitedEdgeCount = <integer>`.
- **Re-run behavior:** Increasing the limit may change the verdict. The receipt must
  not imply finality.

### 2. `CYCLE_DETECTED`

- **Meaning:** The traversal visited an edge whose target was already in the current
  path. A causal cycle exists in the graph.
- **Operational reading:** *Structural circular reasoning risk.* The graph itself
  contains a loop, regardless of any traversal limit.
- **Verdict effect:** `cycle_blocked` (see ADR-V1-004). The traversal *hard-stops*
  on the offending branch. The verdict for the originating claim falls to
  `bilinmiyor` for that branch.
- **Confidence effect:** No confidence penalty; the verdict is `bilinmiyor`, not
  "weakly supported".
- **Risk flag effect:** `risk.flags.circular_reasoning_risk` **is** set.
- **Receipt field:** `traversal.stopReason = "cycle_detected"`,
  `traversal.completed = false`, `traversal.visitedEdgeCount = <integer>`,
  `traversal.cycleEdgeIds = [<edgeId>, ...]`.
- **Re-run behavior:** Increasing the limit will not resolve a cycle. The cycle is a
  graph-level fact.

### Summary Table

| Condition            | stopReason        | Verdict            | Confidence penalty | Risk flag set?              | Hard stop? |
| -------------------- | ----------------- | ------------------ | ------------------- | --------------------------- | ---------- |
| `MAX_DEPTH_EXCEEDED` | `depth_exceeded`  | `depth_incomplete` | Yes (bounded)       | No                          | No         |
| `CYCLE_DETECTED`     | `cycle_detected`  | `cycle_blocked`    | No                  | Yes (`circular_reasoning_risk`) | Yes    |
| Normal terminus      | `terminus`        | (normal verdict)   | No                  | Per other rules            | No         |

### Why Two Outcomes, Not One

- A depth limit is a *resource* signal and the correct operational response is to
  widen the budget, refactor the query, or accept a partial answer with a warning.
- A cycle is a *data* signal. The correct response is to fix the graph (or to flag
  the claim as `bilinmiyor` pending human review). The two responses are not
  interchangeable.
- Conflating them lets a graph with real cycles look like a slow query, and a
  slow query look like a structural problem. Both are operator-hostile.

## Limits and Defaults (proposed, finalized in V1-PR2)

- `MAX_DEPTH = 32` (placeholder).
- `MAX_EDGES = 1024` (placeholder; total visited edges per traversal).
- Both limits are *advisory* in this ADR. The runtime defaults land in V1-PR2.

These limits are runtime configuration, not contract. Changing them does not require
an ADR update, but it must be reflected in the receipt and audit log.

## Determinism

- Traversal order is **relation priority first**, then `edgeId` ascending. The
  relation priority order is the v0.9.1 frozen list: `CAUSES(0) → ENABLES(1) →
  LEADS_TO(2) → DEPENDS_ON(3) → PREVENTS(4)`.
- For the same `(graph snapshot, claim id, config)`, the traversal visits edges in
  the same order, hits the same termination condition, and reports the same
  `visitedEdgeCount`.
- Cycle detection uses a `visited` set keyed on `edgeId` (not on `claimId`). This
  is intentional: a claim may appear in multiple paths without forming a cycle, and
  the receipt must record the *edges* that close a loop, not the *claims* that
  happen to repeat.
- See ADR-V1-005 for the full multiverse determinism contract.

## Error Code Names (proposed)

- `axerr.causal.traversal.depth_exceeded`
- `axerr.causal.traversal.cycle_detected`
- `axerr.causal.traversal.max_edges_exceeded`

These names are proposed. The runtime `AXIOM_ERROR` enum is not extended in V1-PR0;
extension is part of V1-PR2.

## Trust Receipt Shape (additive)

```json
{
  "traversal": {
    "completed": true,
    "stopReason": "terminus",
    "visitedEdgeCount": 17,
    "cycleEdgeIds": [],
    "maxDepthReached": 4
  }
}
```

`maxDepthReached` is reported even on full traversals; it tells the operator how
deep the query actually went.

## Invariants

1. **`MAX_DEPTH_EXCEEDED` and `CYCLE_DETECTED` are distinct.** No code path
   collapses them into a single outcome.
2. **A cycle is a graph-level fact.** Increasing the traversal limit cannot "fix"
   a cycle. The receipt must not imply otherwise.
3. **A depth limit is a resource condition.** The receipt must not imply that the
   traversal is unsafe merely because it hit the limit; only a `warning` is set.
4. **Traversal order is deterministic.** Same input → same order, always.
5. **No silent retries.** If the traversal is re-run with a higher limit, the new
   receipt is a new artifact, not a replacement of the old one. Both are kept for
   audit.

## Out of Scope (V1)

- Probabilistic cycle detection.
- Cycle *breaking* heuristics (e.g., removing the weakest edge in a cycle). V1 only
  reports the cycle.
- What-if / counterfactual traversals.
- Temporal traversals ("as of" semantics).

## Implementation Note

V1-PR0 is docs-only. The runtime traversal module lands in V1-PR2.
