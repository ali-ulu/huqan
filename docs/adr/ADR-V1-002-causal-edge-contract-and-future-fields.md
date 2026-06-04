# ADR-V1-002 — Causal Edge Contract and Future Fields

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** AXIOM core team
- **Supersedes:** —
- **Cross-references:** [ADR-V1-001](./ADR-V1-001-causal-granite-architecture.md), [ADR-V1-003](./ADR-V1-003-traversal-semantics-depth-vs-cycle.md), [ADR-V1-004](./ADR-V1-004-causal-verdict-trust-receipt-bridge.md), [ADR-V1-005](./ADR-V1-005-causal-determinism-multiverse-test-strategy.md)
- **Scope:** V1 Causal Edge JSON contract (schema only; no runtime validator in V1-PR0)

## Context

V1 Causal Granite needs a stable, versioned contract for causal edges. v0.9.1 already
freezes `CAUSAL_RELATIONS = { CAUSES, PREVENTS, ENABLES, DEPENDS_ON, LEADS_TO }` and a
priority order used by traversal. The new contract must:

- Be deterministic and human-readable in reports.
- Carry enough numeric information for downstream causal computation.
- Not over-constrain `provenanceId` to a specific runtime pattern, so the existing
  `lib/provenance-ingest.js` `makeProvenanceId` (sha1 slice + `prov_` prefix) is not
  broken by an ADR-level regex.
- Reserve room for future fields (`temporal`, `probability`, `formalProof`,
  `worldModel`, `causalProjection`, `counterfactualTrace`, `simulationReceipt`)
  without promising runtime semantics in V1.

## Decision

A causal edge is a JSON object with the shape below. Fields marked **required** must
be present and well-typed. Fields marked **optional** may be omitted or `null`.
Fields marked **future** are `null` in V1 and carry no runtime meaning.

### Causal Edge Shape (V1)

```json
{
  "id": "edge_123",
  "from": "claim_a",
  "to": "claim_b",
  "relation": "CAUSES",
  "strength": 0.86,
  "strengthLabel": "strong",
  "confidence": 0.86,
  "workspaceId": "default",
  "provenanceId": "prov_0123456789abcdef",
  "trustPolicyVersion": "1.0",
  "createdAt": "2026-06-05T00:00:00Z",
  "edgeSchemaVersion": "1.0.0",

  "temporal": null,
  "probability": null,
  "formalProof": null,

  "worldModel": null,
  "causalProjection": null,
  "counterfactualTrace": null,
  "simulationReceipt": null,

  "meta": {}
}
```

### Field Semantics

| Field                | Required | Type                              | Notes                                                                                  |
| -------------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `id`                 | yes      | string                            | Edge identifier. Stable across processes.                                              |
| `from`               | yes      | string                            | Source claim/node id.                                                                  |
| `to`                 | yes      | string                            | Target claim/node id.                                                                  |
| `relation`           | yes      | enum                              | One of `CAUSES / PREVENTS / ENABLES / DEPENDS_ON / LEADS_TO` (frozen in v0.9.1).       |
| `strength`           | yes      | number, `0..1`                    | Numeric strength. Used in causal computation.                                          |
| `strengthLabel`      | no       | enum                              | `weak / medium / strong / very_strong`. Human-readable, optional.                      |
| `confidence`         | yes      | number, `0..1`                    | Confidence in the causal link. Distinct from `strength`.                               |
| `workspaceId`        | yes      | string, non-empty                 | Workspace isolation boundary.                                                         |
| `provenanceId`       | yes      | string, non-empty, stable         | Cross-reference to the Trust Kernel provenance record.                                 |
| `trustPolicyVersion` | yes      | string                            | Policy version under which the edge was created.                                       |
| `createdAt`          | yes      | ISO 8601 string                   | Edge creation timestamp.                                                               |
| `edgeSchemaVersion`  | yes      | string                            | Edge contract version. Pinned to `"1.0.0"` in V1.                                       |
| `temporal`           | no       | object \| null                    | Future. `null` in V1.                                                                  |
| `probability`        | no       | object \| null                    | Future. `null` in V1.                                                                  |
| `formalProof`        | no       | object \| null                    | Future. `null` in V1.                                                                  |
| `worldModel`         | no       | object \| null                    | Future (V6+). `null` in V1.                                                            |
| `causalProjection`   | no       | object \| null                    | Future (V6+). `null` in V1.                                                            |
| `counterfactualTrace`| no       | object \| null                    | Future (V6+). `null` in V1.                                                            |
| `simulationReceipt`  | no       | object \| null                    | Future (V6+). `null` in V1.                                                            |
| `meta`               | no       | object                            | Free-form, non-interpreted metadata. Must not contain any field listed above.          |

### Strength and Label Mapping (proposed, finalized in V1-PR1)

The optional `strengthLabel` should be consistent with `strength`. V1-PR1 will
finalize the bands; the proposed bands are:

| Range (inclusive)   | Label         |
| ------------------- | ------------- |
| `[0.00, 0.25)`      | `weak`        |
| `[0.25, 0.50)`      | `medium`      |
| `[0.50, 0.75)`      | `strong`      |
| `[0.75, 1.00]`      | `very_strong` |

If `strengthLabel` is provided, it must agree with `strength` under the finalized
bands. If it is omitted, no label is reported.

### `provenanceId` Contract (soft)

`provenanceId` must be **non-empty and stable**.

- Recommended format: `prov_<deterministic-id>`.
- The exact runtime pattern (length, alphabet, separators) will be **finalized in
  V1-PR1**.
- This ADR does **not** impose a hard regex. Doing so risks breaking the existing
  `lib/provenance-ingest.js` `makeProvenanceId` (sha1 slice + `prov_` prefix) and any
  downstream producer that emits IDs in a different but stable shape.
- Stability is what matters: a given edge's `provenanceId` must be reproducible from
  the same `(workspaceId, from, to, relation, createdAt)` inputs.

### Validation Rules (V1, high level)

A causal edge is *valid* in V1 if and only if:

1. All required fields are present and well-typed.
2. `relation` is one of the five frozen values.
3. `strength ∈ [0, 1]`.
4. `confidence ∈ [0, 1]`.
5. `workspaceId` is non-empty.
6. `provenanceId` is non-empty and stable.
7. `trustPolicyVersion` matches the active policy version.
8. `edgeSchemaVersion === "1.0.0"`.
9. If `strengthLabel` is present, it agrees with `strength` under the finalized bands.
10. None of the `future` fields is non-`null`. (V1 forbids them; this is part of the
    contract surface.)

A formal runtime validator implementing the above lands in **V1-PR1**, not V1-PR0.

### Versioning

- `edgeSchemaVersion = "1.0.0"` is pinned in V1.
- Any non-additive change to the edge shape (new required field, removed field,
  semantic change to an existing field) requires a major version bump and a new ADR
  in the V1.x series.

## Invariants

1. **Provenance is mandatory.** An edge without a valid `provenanceId` cannot enter
   the canonical graph. This protects the v0.9.1 invariant that
   `unsupported`/`contradicted` claims must not become trusted memory.
2. **Future fields are doors, not implementations.** Reading `temporal`,
   `probability`, `formalProof`, `worldModel`, `causalProjection`,
   `counterfactualTrace`, or `simulationReceipt` as anything other than `null` in
   V1 is a contract violation. Downstream code must check for `null` explicitly.
3. **`strength` is numeric.** A label-only representation is rejected; V1 causal
   computation consumes the number. The label exists for human-readable reports
   only.
4. **`strengthLabel` is consistent with `strength` when present.** Inconsistent
   labels are validator errors in V1-PR1.
5. **No backdoor mutation.** Edge construction is additive to the public API. No
   edge path bypasses Memory Core, the Semantic Trust Gate, the Trust Kernel, or
   the audit log.

## Out of Scope (V1)

- Numeric probability distributions over edges.
- Temporal ordering, decay, or "as-of" semantics.
- Formal proof attachment (Z3, Lean, Coq, etc.).
- World-model projection or simulation.
- Counterfactual trace generation.

## Implementation Note

V1-PR0 is docs-only. No `lib/causal/causal-edge.js` exists yet. V1-PR1 introduces the
runtime validator that implements the rules above.
