# P1-C — Admission boundary: change-surface measurement

## Purpose

Gate 2 closed with `NO_EXISTING_UNIVERSAL_HOOK` and required a common admission
boundary at the kernel's mutation orchestration layer. Two candidates were
available. This measures their change surface.

**This document makes no implementation decision.** It measures and reports a
verdict.

## Canonical base

```text
repository: ali-ulu/huqan
main: 754687f112a1df3caa88065b405473a23dc005ea
```

## Candidates

| Candidate | Shape |
|---|---|
| **A** | Make `graph.runMutationOnce` mandatory — route every write family through the existing wrapper |
| **B** | Introduce a new admission seam above the four families, leaving the sinks unchanged |

## Hard constraints

```text
must_cover_all_mutation_families                 = true
must_be_non_opt_in                               = true
existing_fail_closed_semantics_must_not_be_weakened = true
```

## Verdict

```text
B PREFERRED / A REJECTED
```

A was the expected winner — `runMutationOnce` is already at the right altitude,
already durable and once-only. The measurement does not support that
expectation, and the reason is structural rather than a matter of effort.

## Measurement 1 — call sites

Every direct call to a sink in the four write families, at the canonical base.

| Sink | Production-reachable | Library-only / backend | Total |
|---|---|---|---|
| `addNode` | 8 | 3 | 11 |
| `addEdge` | 9 | 4 | 13 |
| `addTag` | 1 | 0 | 1 |
| `addCandidateClaim` | 8 | 1 | 9 |
| `appendAuditEvent` | 7 | 1 | 8 |
| **Total** | **33** | **9** | **42** |

Production-reachable callers (9 files): `kernel.js`, `kernel.v2.js`,
`agent.v3.js`, `server.js`, `lib/conflict-detector.js`,
`lib/learn-use-case.js`, `lib/external-client-mutation-receipt-owner.js`,
`lib/cli-mutation-audit.js`, `lib/mcp-ingest-execute-tool.js`.

Excluded as not production-reachable: `lib/self-healer/*` and
`lib/github-connector.js` (both in `NOT_YET_WIRED`), and `rustGraph.js`, which
extends `Graph` and therefore *implements* the sink API rather than calling it.

## Measurement 2 — test surface

Test files calling each sink directly:

| Sink | Test files |
|---|---|
| `addNode` | **45** |
| `addEdge` | **33** |
| `appendAuditEvent` | 11 |
| `runMutationOnce` | 9 |
| `addCandidateClaim` | 2 |

This is the decisive number, and it is the one that separates the candidates.

`addNode` and `addEdge` are called directly by 45 and 33 test files. Any change
to their signature or contract puts the criterion
`existing caller contracts hold unchanged` immediately out of reach. **A** requires
such a change; **B**, by construction, requires none.

## Measurement 3 — can A be made non-opt-in?

This is where A fails, and it fails structurally rather than by cost.

`graph.runMutationOnce(operationId, mutate, opts)` (`graph.js:516`) takes a
caller-supplied `operationId` and a caller-supplied callback. It is a
**caller-applied** pattern by construction: it can only run if a caller chooses
to wrap a write in it.

There are exactly two ways to remove that choice, and both are dead ends:

1. **Have the sinks call it internally.** Then admission runs *inside*
   `addNode`/`appendAuditEvent`, at storage altitude — precisely the placement
   Gate 2 rejected as wrong layer, because identity, workspace, delegation and
   connector context would have to be carried down to a layer that should stay
   ignorant of who is asking. The sinks also have no access to that context
   today, so it would have to be threaded through all 42 call sites anyway.
2. **Leave the sinks public and require callers to wrap.** That is the status
   quo, and it is opt-in by definition: a caller that forgets simply writes.
   Adding the wrapper at all 33 production call sites does not change this —
   the 34th call site is unguarded, which is exactly the failure mode this
   constraint exists to prevent.

So A cannot satisfy `must_be_non_opt_in` without becoming the wrong-layer option
Gate 2 already rejected. **`A: REJECTED`** — on constraint violation, not on
effort.

A secondary finding, recorded because it would otherwise be discovered late:
`rustGraph.js` extends `Graph` and reimplements sinks, so any sink-level
enforcement in A would have to be mirrored there or silently bypassed by the
Rust backend.

## Measurement 4 — B's change surface

B introduces a seam above the families and leaves the sinks alone.

| Change | Surface |
|---|---|
| Sink signatures | **0** — no `graph.js` write method changes |
| Test files needing change | **0** from Measurement 2's 78 `addNode`/`addEdge` files |
| Production callers to route through the seam | **9 files, 33 call sites** |
| New module | 1 admission seam at kernel orchestration altitude |

B's cost is real and is concentrated where it should be: in the callers that
perform mutations, not in the storage API or in the test suite that describes it.

### How B satisfies `must_be_non_opt_in`

Routing 33 call sites does not by itself make the seam non-declinable — a 34th
call site could still bypass it. The mechanism that closes this is one the
repository already uses in eight places: a **boundary contract test** that fails
when a runtime file calls a sink directly outside the seam.

Existing precedents: `test/arch-3-file-size-ratchet.contract.test.js`,
`test/arch-4-kernel-version-parity.contract.test.js`,
`plugin-boundary-contract.test.js`, `path-containment-386.test.js`,
`test/module-reachability.test.js`, `test/tenancy-boundary.test.js`.

This matters more than it first appears: **the non-opt-in property is separable
from the seam's location.** It is achieved by a CI-enforced guard with an
explicit exemption list, not by restructuring the API — which is why B can be
non-opt-in while leaving 78 test files untouched, and why A gains nothing by
being "already at the right altitude".

### `existing_fail_closed_semantics_must_not_be_weakened` under B

`kernel.learn`'s existing behaviour is preserved by construction, because B adds
a seam above it rather than modifying it:

- the critical section (`kernel.js:743`) is untouched;
- the `DURABLE_MUTATION_JOURNAL_UNAVAILABLE` throw (`kernel.js:748-751`) is
  untouched;
- `runMutationOnce` remains available and in use by the callers that already
  apply it.

B adds a fail-closed check; it removes none. Under A the durability semantics
would have to be re-established for four families at once, with the audit family
— which has no `operationId` today — the most exposed.

## What this does not measure

- **Contract preservation is projected, not observed.** B is measured as
  requiring no change to the 78 `addNode`/`addEdge` test files because it changes
  no sink signature. That is a structural inference. It becomes evidence only
  when a candidate implementation runs the suite.
- The admission seam's own module boundary and API are not designed here.
- Whether all four families can share one context shape is not established;
  the audit family lacking an `operationId` is the first known asymmetry.

## Recommendation to the implementing unit

Not a decision, and it deliberately does not name files:

1. Introduce the seam at kernel orchestration altitude, above the four families.
2. Add the boundary contract test **before** routing the call sites, so the
   remaining unrouted sites are enumerated by a failing test rather than by
   inspection, and the exemption list shrinks visibly as they are routed.
3. Verify the guard fails on an injected direct call before trusting it — a
   guard that cannot fail is worthless.
4. Re-run Gate 2's two deferred measurements — reachability and contract
   preservation — against the result.

## Non-claims

This document does not claim that an admission seam exists, that B has been
implemented or authorized, that contract preservation has been observed, that
the four families can share a single context shape, that identity enforcement
exists, or that any third party has verified anything.
