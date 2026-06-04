# ADR-V1-005 — Causal Determinism and Multiverse Test Strategy

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** AXIOM core team
- **Supersedes:** —
- **Cross-references:** [ADR-V1-001](./ADR-V1-001-causal-granite-architecture.md), [ADR-V1-002](./ADR-V1-002-causal-edge-contract-and-future-fields.md), [ADR-V1-003](./ADR-V1-003-traversal-semantics-depth-vs-cycle.md), [ADR-V1-004](./ADR-V1-004-causal-verdict-trust-receipt-bridge.md)
- **Scope:** V1 causal determinism contract and multiverse test strategy

## Context

Trust Receipts and audit logs are only as useful as the receipts are reproducible.
A causal verdict that depends on the wall clock, on a non-seeded PRNG, on file
order, or on process startup order is, in practice, not a verdict — it is a
suggestion. V1 Causal Granite must therefore be deterministic end to end, and the
determinism must be *testable* in CI.

V0.9.1 already enforces some determinism (e.g., the canonical-JSON serializer used
in the Trust Kernel). V1 extends the same discipline to the causal layer.

## Decision

### Definition

A causal computation is **deterministic** if, for the same input triple

```text
(graph snapshot, query, config)
```

it produces the same:

1. **Traversal order** (the sequence of edge ids visited).
2. **Termination condition** (`terminus`, `depth_exceeded`, `cycle_detected`).
3. **Verdict** (`supports`, `contradicts`, `inconclusive`, `cycle_blocked`,
   `depth_incomplete`).
4. **Confidence** (numeric, in `[0, 1]`).
5. **Trust Receipt payload** (byte-stable under canonical JSON).
6. **Audit event order** (the sequence of `AUDIT_EVENTS` written for the
   computation).

If any of (1)–(6) varies across runs with the same input triple, the computation is
non-deterministic and the test fails.

### Multiverse Determinism

A *multiverse* test runs the same causal computation under varying environmental
conditions and asserts byte-stable output:

- Different processes (separate `node` invocations).
- Different OS / CPU combinations (CI matrix).
- Different wall-clock times (no time-of-day dependency).
- Different working directories.
- Different process startup orders when multiple computations are spawned.

All runs must produce a byte-equal canonical-JSON output for the same input triple.
Canonical JSON is defined as: object keys sorted lexicographically at every
nesting level; numbers serialized without trailing zeros; no `undefined`; no
functions; arrays preserve order.

### Seed Strategy

V1 forbids hidden randomness in the causal layer. Specifically:

- No `Math.random()` calls reachable from the causal module path.
- No non-seeded PRNG usage.
- If randomness is ever required (e.g., for sampling in a future PRNG-driven
  what-if feature), the seed must be read from a deterministic source and recorded
  in the receipt.

In V1-PR0 there is no runtime code, so the seed contract is documented here and
will be enforced by a CI test in V1-PR1 onward.

### Forbidden Behaviors

The following are *contract violations* in V1:

1. **Time-dependent verdict.** Reading `Date.now()`, `process.hrtime()`, or any
   other monotonic clock inside the causal computation path.
2. **Hidden PRNG.** Any `Math.random()` or non-seeded PRNG reachable from
   `lib/causal/`.
3. **Test-order dependency.** Module-level mutable state that changes between tests
   without explicit reset.
4. **Parallel divergence.** Running the same computation in parallel and getting
   different results. (This usually comes from a shared mutable structure; V1
   forbids it.)
5. **File-order dependency.** Iterating files or directories in `readdir` order
   without an explicit sort.
6. **Locale-dependent serialization.** Numbers or strings formatted with the
   default locale.

### CI Gate

A determinism test pack is part of `npm test`. The pack is intentionally
duplicative of ordinary tests but with a stricter byte-equality check:

- `test/causal-determinism.test.js` — multiverse runs of representative
  traversals; expects byte-equal canonical JSON.
- `test/causal-edge-schema.test.js` — validator determinism (see ADR-V1-002).
- `test/causal-traversal.test.js` — `MAX_DEPTH_EXCEEDED` and `CYCLE_DETECTED`
  determinism (see ADR-V1-003).
- `test/causal-receipt-bridge.test.js` — verdict → receipt mapping determinism
  (see ADR-V1-004).

The pack runs serially (`node --test --test-concurrency=1`, matching v0.9.1) so
that module-level state cannot cause order-dependent output.

### Test Plan Summary (V1-PR6)

V1-PR6 introduces the determinism test pack. The pack is *not* introduced in
V1-PR0; this ADR documents the contract that V1-PR1 onward must honor.

Concretely, V1-PR6 must cover at minimum:

- One linear chain of 32+ edges: determinism across two processes.
- One branchy graph with at least 3 outgoing edges per node: traversal order
  determinism by `edgeId` ascending within the same relation priority.
- One graph with a deliberate cycle: cycle detected, branch hard-stopped,
  determinism preserved.
- One graph that hits `MAX_DEPTH`: depth exceeded, partial traversal, deterministic
  `visitedEdgeCount`.
- One gate-failing scenario: `supports` verdict, but `riskScore >= riskHigh`; the
  receipt records `bilinmiyor` and the warning, deterministically.
- One canonical-JSON roundtrip: take the receipt, parse, re-serialize, assert
  byte-equal.

If any of these fail, V1 cannot ship. They are CI gates, not aspirational
guidelines.

### Trust Receipt and Determinism

The Trust Receipt for a V1 causal computation must include enough information to
re-verify the result. In particular:

- `causal.traversal.visitedEdgeCount` and `causal.traversal.cycleEdgeIds` together
  identify the exact edges that were walked.
- `causal.gates` records the gate results at the time of the verdict.
- `causal.verdict` records the verdict; it does not change between runs.

A future PR may add a `causal.computationHash` that hashes the canonicalized
inputs + outputs for fast equality checks. V1 does not introduce this field.

## Invariants

1. **Determinism is a contract.** A non-deterministic causal computation is a
   contract violation, not a bug to be tolerated.
2. **Multiverse tests run in CI.** A change that breaks multiverse determinism
   cannot be merged.
3. **No hidden randomness.** Any PRNG usage in the causal module path must be
   seeded and recorded.
4. **Canonical JSON is the equality basis.** Equality is byte-equality under
   canonical-JSON serialization, not deep object equality.
5. **Determinism is testable in CI today.** V0.9.1 already runs
   `node --test --test-concurrency=1`; the determinism pack plugs into this
   runner without new tooling.

## Out of Scope (V1)

- Probabilistic causal models (Bayesian networks, etc.).
- Distributed determinism across multiple machines (only single-process determinism
  is required in V1).
- Determinism of the future temporal/probabilistic/formal-proof layers.

## Implementation Note

V1-PR0 is docs-only. The determinism test pack lands in V1-PR6.
