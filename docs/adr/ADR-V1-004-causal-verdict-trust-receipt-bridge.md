# ADR-V1-004 — Causal Verdict and Trust Receipt Bridge

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** AXIOM core team
- **Supersedes:** —
- **Cross-references:** [ADR-V1-001](./ADR-V1-001-causal-granite-architecture.md), [ADR-V1-002](./ADR-V1-002-causal-edge-contract-and-future-fields.md), [ADR-V1-003](./ADR-V1-003-traversal-semantics-depth-vs-cycle.md), [ADR-V1-005](./ADR-V1-005-causal-determinism-multiverse-test-strategy.md)
- **Scope:** V1 causal verdict enum, mapping to Trust Receipt, gating with semantic trust + risk + provenance

## Context

The v0.9.1 Trust Receipt already carries `verify.status ∈ { dogrulandi, celiski,
bilinmiyor }` and an audit trail. The simplest way to add causal reasoning would be
to make causal `supports` map directly to `dogrulandi`. This is rejected: the
v0.9.1 invariant "no contradiction found ≠ verified" must hold, and a causal
`supports` alone is not evidence of truth — it is evidence of structural
consistency.

V1 Causal Granite must therefore:

- Introduce a *causal verdict* enum that is distinct from `verify.status`.
- Map causal verdicts to `verify.status` only when semantic trust, risk, and
  provenance gates all pass.
- Surface causal metadata in the Trust Receipt as an additive `causal` block.
- Map causal events to existing `AUDIT_EVENTS` (no new event type is added in V1).

## Decision

### Causal Verdict Enum (V1)

```text
supports            — traversal found consistent causal evidence, no contradictions
contradicts         — traversal found explicit contradictions
inconclusive        — traversal finished without support or contradiction
cycle_blocked       — traversal hit a cycle (see ADR-V1-003)
depth_incomplete    — traversal hit the depth limit (see ADR-V1-003)
```

### Mapping to `verify.status` (gated)

A causal verdict maps to `verify.status` **only if** the corresponding gating
conditions are satisfied. Otherwise the receipt records the causal verdict, a
warning, and `verify.status: bilinmiyor`.

| Causal verdict      | `verify.status`         | Conditions (ALL must hold)                                                                                                              |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `supports`          | `dogrulandi`            | `semanticTrust.support >= supportVerified threshold` **AND** `contradictionScore < contradictionConflict threshold` **AND** `riskScore < riskHigh threshold` **AND** `provenance.valid === true` |
| `contradicts`       | `celiski`               | (no extra gate — contradiction is decisive)                                                                                            |
| `inconclusive`      | `bilinmiyor`            | (always; no positive evidence)                                                                                                          |
| `cycle_blocked`     | `bilinmiyor`            | `risk.flags.circular_reasoning_risk = true`                                                                                            |
| `depth_incomplete`  | `bilinmiyor`            | `warnings.push("partial_traversal")`, confidence penalty applied (see ADR-V1-003)                                                     |

If any of the `supports` gating conditions fails, the mapping is:

```text
supports → bilinmiyor
with: warnings.push("causal_supports_but_gates_failed")
```

The receipt must **not** show `dogrulandi` for a `supports` verdict whose gates
failed. The `causal.verdict` field retains `supports` so that the operator can see
the structural result; the `verify.status` field falls to `bilinmiyor`.

### Why the Gate Is Necessary

A causal `supports` verdict means the graph is *internally consistent* with respect
to the claim. It does not mean:

- The claim is *true* in the world. (Truth requires semantic + provenance + risk.)
- The claim is *non-contradictory*. (Contradiction is detected by the Semantic Trust
  Gate, not by the causal traversal alone.)
- The claim is *safe to act on*. (Safety requires risk gates, which include
  `HIGH_RISK_DOMAINS`, `ABSOLUTE_TERMS`, and the rest of `lib/risk-rules.js`.)

Without the gate, a `supports` verdict could be weaponized into a false-positive
`dogrulandi` simply by chaining consistent-but-wrong claims. The gate keeps the
causal layer honest: it tells you the graph is consistent; the rest of the system
decides whether that is enough.

### Threshold Constants (frozen, inherited from v0.9.1)

The thresholds below are read from the v0.9.1 frozen `DEFAULT_SEMANTIC_THRESHOLDS`
(see `lib/semantic-score.js`). V1 does not introduce new thresholds; it consumes
the existing ones.

| Constant                   | Value |
| -------------------------- | ----- |
| `supportVerified`          | 0.75  |
| `contradictionConflict`    | 0.70  |
| `riskHigh`                 | 0.40  |

A future ADR may extend the threshold set; that would be a v1.x ADR, not a V1
change.

### Provenance Validity (gate)

`provenance.valid === true` means **all** of the following hold:

1. `provenanceId` is non-empty and stable (see ADR-V1-002).
2. `trustPolicyVersion` matches the active policy version.
3. `source` is in `VALID_SOURCE_TYPES` (frozen in `lib/provenance-ingest.js`).
4. The provenance record is reachable through `provenance-query` and not in
   `rejected` status.

This reuses the existing Trust Kernel invariants; V1 does not redefine them.

### Trust Receipt Payload (additive `causal` block)

```json
{
  "verify": {
    "status": "dogrulandi",
    "confidence": 0.83
  },
  "causal": {
    "verdict": "supports",
    "bridge": "pass",
    "traversal": {
      "completed": true,
      "stopReason": "terminus",
      "visitedEdgeCount": 17,
      "cycleEdgeIds": [],
      "maxDepthReached": 4
    },
    "confidence": 0.83,
    "gates": {
      "semanticTrust": "pass",
      "contradiction": "pass",
      "risk": "pass",
      "provenance": "pass"
    }
  }
}
```

`bridge` is one of:

- `pass` — verdict and gates agree.
- `blocked` — `cycle_blocked`; the verdict cannot be trusted regardless of gates.
- `degraded` — verdict reached but at least one gate failed (e.g., `supports` with
  `causal_supports_but_gates_failed` warning).

### Audit Mapping (no new `AUDIT_EVENTS`)

Causal events are mapped onto the existing frozen `AUDIT_EVENTS` set in
`lib/audit-log.js`:

| Causal outcome                            | Audit event           |
| ----------------------------------------- | --------------------- |
| `supports` with all gates passing         | `CLAIM_ACCEPTED`     |
| `supports` with a gate failure            | `CLAIM_FLAGGED`      |
| `contradicts`                             | `CLAIM_REJECTED`     |
| `inconclusive`                            | `REAFFIRMED`         |
| `cycle_blocked`                           | `CLAIM_FLAGGED`      |
| `depth_incomplete`                        | `CLAIM_FLAGGED`      |

V1 does **not** add a new `AUDIT_EVENTS` entry. The mapping is stable; changing it
requires a new ADR.

## Invariants

1. **No contradiction found ≠ verified.** A `supports` verdict alone never implies
   `dogrulandi`. All four gates must pass.
2. **A gate failure is visible.** The receipt records both the verdict and the
   gate result; the operator must be able to see why a `supports` did not promote
   to `dogrulandi`.
3. **`cycle_blocked` is decisive.** A cycle in the causal graph is a structural
   problem; the verdict is `bilinmiyor` for that branch regardless of other gates.
4. **Canonical memory still requires review.** Even a `supports` verdict with all
   gates passing does not bypass the Memory Core review gates. V1 does not weaken
   the v0.9.1 `shouldLearn` invariant.
5. **No new `AUDIT_EVENTS` in V1.** New event types are a v1.x concern.
6. **Receipt payload is additive.** The existing `verify.status` field is
   preserved. The `causal` block is added alongside, never replacing.

## Out of Scope (V1)

- Counterfactual verdicts ("what would have happened if...").
- Probabilistic verdicts.
- Temporal verdicts ("as of time T").
- Formal-proof verdicts.

## Implementation Note

V1-PR0 is docs-only. The runtime bridge lands in V1-PR5.
