# V5 P1 Gate 2 — Runtime hook location

**Status:** `closeout`

**Canonical base:** `main @ c7d5bf56f9e105130132ac8f6984068e91fc09c6` — the merge
that put the Gate 2 source-reality measurement (PR `#858`) on `main`. Docs-only:
it records a verdict, and authorizes no code.

## Verdict

```text
GATE_2_RUNTIME_HOOK_LOCATION: NO_EXISTING_UNIVERSAL_HOOK
```

Gate 2 asked which runtime surface should carry identity enforcement. The
measured answer is that **the question had no correct answer among the
candidates**, and this closeout records that rather than forcing one.

No hook is selected. Gate 2 is closed as measured, not as satisfied.

## What was measured

`docs/task-packs/p1b-gate2-hook-source-reality.md` measured four production
surfaces against the criteria fixed in
`docs/v5/v5-p1a-identity-threat-model.md`:

| Surface | Verdict |
|---|---|
| `github-app-server.js` | `REJECTED` — no mutation path exists |
| `cli.js` | `PARTIAL` |
| `mcpServer.js` | `PARTIAL` |
| `server.js` | `PARTIAL` |

No surface measured `SUPPORTED`.

## Why neither candidate was selected

Two placements were available on the evidence. Both were rejected, for opposite
reasons.

### `kernel.learn()` — right layer, wrong scope

Attractive: it is shared by all three mutating surfaces, needs no per-surface
placement, and inherits an existing critical section plus an existing
fail-closed durability check.

Rejected because it is the chokepoint of **one** write family. `runCapability`
writes, direct audit writes, and candidate-claim writes do not pass through it.
Selecting it as *the* identity enforcement hook would mean accepting, at the
moment of the decision, a set of mutations that are knowably unenforced — and
reporting the surface as covered while they are.

### The `graph.js` write API — wrong layer

Rejected because it contradicts the measurement it would be based on. There is
no single `graph.js` write API: there are four sink families. Treating them as
one existing seam would restate the very finding that produced this verdict.

It is also the wrong altitude. Carrying identity, workspace, delegation and
connector context down to the storage API would make storage
security-aware — a layer that should stay ignorant of who is asking becomes
responsible for deciding it.

## The requirement this places on P1 implementation

Identity enforcement must not be produced by selecting one of the existing
surface hooks. It requires a **common admission boundary at the kernel's
mutation orchestration layer** — above the storage sinks, below the callers —
that every mutation family must pass through:

```text
caller
  ↓
kernel mutation admission
  ↓
identity / workspace / expiry / delegation / connector checks
  ↓
existing mutation families
  ↓
effect
```

The checks are the acceptance predicate from P1-A, unchanged. What Gate 2 adds
is where it has to sit.

### The nearest existing structure, and why it does not qualify

`graph.runMutationOnce` (`graph.js:516`) is the closest thing the repository has
to this seam. It is at the right altitude — mutation orchestration, not
storage — and it already provides durable, once-only execution.

It does not qualify today because it is **opt-in**. Verified at the canonical
base: `addNode`, `addEdge`, `appendAuditEvent` and `addCandidateClaim` contain no
call to it. Callers apply it — `kernel.learn`, `lib/conflict-detector.js`,
`lib/external-client-mutation-receipt-owner.js`,
`lib/receipt/v4-receipt-family.js` — and callers that do not simply write.

A boundary a caller may decline is not a boundary. So P1's first implementation
task is not to add checks; it is to establish a seam that **cannot** be declined,
whether by making this one mandatory or by introducing one above it.

## Re-entry conditions

The remaining two Gate 2 measurements are deferred, not waived. They are re-run
against the admission boundary once it exists:

1. **Reachability** — do all four mutation families provably pass through the
   boundary? `lib/module-reachability.js` is the existing instrument.
2. **Contract preservation** — do the existing caller contracts hold unchanged?
   Reported as *not measured* in `#858` because no candidate implementation
   existed to test; that remains true.

A runtime identity hook counts as selected only after both pass. Until then, the
correct statement is that P1 has a specified boundary and no enforcement point.

## Effect on the remaining gates

Gate 2 is closed with a verdict; it is not satisfied. Gates 3 through 8 remain
untouched, and the identity closeout audit's forbidden claim — "HUQAN has runtime
identity enforcement" — continues to apply in full.

## Non-claims

This closeout does not claim that a runtime hook has been selected, that an
admission boundary exists, that `runMutationOnce` is or will become that
boundary, that any mutation family is enforced, that identity enforcement exists,
that gates 3 through 8 are addressed, or that any third party has verified
anything.
