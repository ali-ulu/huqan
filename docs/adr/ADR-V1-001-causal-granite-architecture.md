# ADR-V1-001 — Causal Granite Architecture

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** AXIOM core team
- **Supersedes:** —
- **Cross-references:** [ADR-V1-002](./ADR-V1-002-causal-edge-contract-and-future-fields.md), [ADR-V1-003](./ADR-V1-003-traversal-semantics-depth-vs-cycle.md), [ADR-V1-004](./ADR-V1-004-causal-verdict-trust-receipt-bridge.md), [ADR-V1-005](./ADR-V1-005-causal-determinism-multiverse-test-strategy.md)
- **Scope:** V1 Causal Granite (docs-only architecture ADR)

## Context

v0.7 introduced an early causal layer that has since been retired. The current runtime
(v0.9.1) ships a stable Memory Core, Semantic Trust Gate, Trust Kernel, and Trust Receipt
pipeline. The user-facing product narrative now demands a *causal consistency kernel* on
top of these foundations: a deterministic, receipt-bearing way to reason about why a
claim, decision, or action follows from other claims, decisions, or actions.

The naive path — restoring the v0.7 causal code — is rejected because it has no
determinism contract, no Trust Receipt bridge, and no compatibility with the v0.9.1
provenance + memory + semantic trust invariants.

The chosen path is to introduce a *new* module under `lib/causal/` that is additive,
read-by-default, and explicitly forward-compatible with temporal, probabilistic, and
formal-proof placeholders, without resurrecting the old runtime.

## Decision

V1 = **Causal Granite**.

V1 introduces a new, additive causal consistency kernel on top of v0.9.1, with the
following properties:

1. **Deterministic.** Same input + state → same traversal order, same verdict, same
   Trust Receipt payload, same audit event order. (See ADR-V1-005.)
2. **Receipt-bearing.** Every causal verdict is attached to a Trust Receipt and an
   audit event. (See ADR-V1-004.)
3. **Memory-aware.** Edges are created only from claims with valid provenance and a
   non-`unsupported`/non-`contradicted` semantic status. (See ADR-V1-002.)
4. **Forward-compatible.** Temporal, probabilistic, formal-proof, and world-model
   placeholders exist in the schema as `null` values; runtime semantics are explicitly
   out of scope for V1.
5. **Backwards-compatible.** No v0.9.1 public API, schema, or frozen list is changed.
   `CONTRACT_VERSION = '1.0.0'` is preserved. `MEMORY_SCHEMAS`, `AUDIT_EVENTS`,
   `CAUSAL_RELATIONS`, `CAUSAL_RELATION_PRIORITY`, `MEMORY_STATUSES`,
   `MEMORY_EVENT_TYPES`, `MEMORY_LINK_RELATIONS`, `VALID_SOURCE_TYPES`, and
   `TRUST_STATUSES` remain frozen.
6. **Read-by-default.** Edges are produced by V1 logic, but canonical graph mutation
   through causal edges still requires the same review gates as any other memory
   write. "Causal supports" never bypasses human review.

## Module Layout (proposed)

```text
lib/causal/
  causal-edge.js          # Edge construction + schema validation
  causal-traversal.js     # Deterministic traversal + MAX_DEPTH/CYCLE handling
  causal-simulator.js     # What-if skeleton (placeholder; V1-PR3)
  causal-verdict.js       # Verdict aggregation over traversal output
  causal-trace.js         # Step-by-step trace (additive, receipt-bound)
  causal-receipt.js       # Verdict → Trust Receipt bridge
```

V1-PR0 does **not** create any of these files. V1-PR0 only records the architectural
decision. Runtime files land in V1-PR1 onward.

## Layer Diagram (text)

```
                    +-----------------------+
                    |  External Caller / UI |
                    +-----------+-----------+
                                |
                                v
+-----------------+   +-----------------+   +-----------------+
|  Semantic Trust |-->|  Trust Receipt   |-->|  Audit Log      |
|  Gate           |   |  (Trust Kernel)  |   |  (append-only)  |
+--------+--------+   +--------+--------+   +--------+--------+
         |                     |                     |
         v                     v                     v
+-----------------+   +-----------------+   +-----------------+
|  Memory Core    |-->|  Causal Granite |-->|  Provenance      |
|  (v0.9.1)       |   |  (V1, additive)  |   |  (Trust Kernel)  |
+-----------------+   +-----------------+   +-----------------+
                                |
                                v
                     +-----------------+
                     |  Trust Policy   |
                     |  (JSON, frozen) |
                     +-----------------+
```

Causal Granite sits *above* Memory Core and *beside* the Semantic Trust Gate. It reads
the graph and provenance, and it writes to the Trust Receipt and Audit Log. It does
**not** mutate the canonical graph without the same review gates as any other write.

## Consequences

### Positive

- A clear, additive home for causal reasoning that respects v0.9.1 invariants.
- A future-proof schema that can host temporal, probabilistic, and formal-proof
  features without a breaking migration.
- A receipt-bearing verdict that the rest of the pipeline (Trust Receipt, Audit Log)
  can already consume.
- A deterministic test strategy (ADR-V1-005) that prevents silent nondeterminism.

### Negative

- v0.7 causal code is **not** restored; any prior tests that depended on it must
  already have been removed by the v0.7 retirement. There is no backwards-compat
  promise to the v0.7 causal API.
- Forward-compat placeholders risk being read as "implemented" by future readers.
  This ADR explicitly states they are *doors*, not implementations.
- A new module surface (`lib/causal/`) increases the area the security gate and the
  Self-Healer scanner must cover. V1-PR0 does not add security-sensitive code, but
  the surface is noted.

## Alternatives Considered

- **(a) Restore v0.7 causal runtime.** Rejected. No determinism contract, no
  provenance bridge, no Trust Receipt coupling. Carries dormant risk.
- **(b) Adopt a third-party causal/graph library.** Rejected. Governance and
  supply-chain risk; would require an upstream security review outside the AXIOM
  threat model.
- **(c) Embed causal reasoning into the existing Semantic Trust Gate.** Rejected.
  Couples verification and causal traversal, weakening single-responsibility and
  testability.

## Invariants (cross-cutting)

1. **No contradiction found ≠ verified.** A `supports` causal verdict alone never
   implies `verify.status: dogrulandi`. See ADR-V1-004 for the full condition set.
2. **Determinism.** A causal traversal, verdict, and receipt are byte-stable for the
   same input. See ADR-V1-005.
3. **MAX_DEPTH_EXCEEDED ≠ CYCLE_DETECTED.** These are distinct runtime outcomes with
   different Trust Receipt semantics. See ADR-V1-003.
4. **Forward-compat placeholders are doors, not implementations.** `temporal`,
   `probability`, `formalProof`, `worldModel`, `causalProjection`,
   `counterfactualTrace`, `simulationReceipt` are `null` in V1. Reading them as
   anything other than `null` is a contract violation.
5. **No auto-merge, no auto-push, no canonical memory mutation without review.**
   Causal edges do not change this rule.

## Out of Scope (V1)

- Restoring any v0.7 causal runtime.
- Runtime simulation, what-if execution, counterfactual planning.
- Probabilistic semantics over causal edges.
- Temporal semantics (e.g., event-time ordering, decay).
- Formal proof integration (Z3, Lean, etc.).
- External A2A agent marketplace.
- GitHub App / Streaming Trust runtime.

## Implementation Note

V1-PR0 is **docs-only**. No source code under `lib/`, `kernel.js`, `kernel.v2.js`,
`server.js`, `mcpServer.js`, or `public/` is changed by V1-PR0.
