# P1-B — Gate 2 hook location: source reality

## Purpose

Measure the four production surfaces against the hook-selection criteria fixed by
`docs/v5/v5-p1a-identity-threat-model.md`, so that Gate 2's choice is forced by
evidence rather than argued as architectural preference.

**This document selects no hook.** It measures, and it reports one verdict per
surface. Gate 2 decides.

## Canonical base

```text
repository: ali-ulu/huqan
main: 91db9bcfa15dfd1ab612d90ad5f155ace5011938
```

All findings below were read from live source at that commit. A successor must
verify its own SHA rather than trusting this one.

## Measurement standard

From P1-A, unchanged:

| Measurement | Evidence sought |
|---|---|
| Mutation reachability | Do all real mutation paths pass through one point? |
| Pre-effect position | Does enforcement run before the mutation? |
| Fail-closed | Does it stop safely when identity/context cannot be resolved? |
| Receipt evidence | Can the control produce a deterministic reason/provenance? |
| Contract preservation | Do the surface's existing tests pass unchanged? |

Verdicts: **SUPPORTED** (all criteria evidenced) / **PARTIAL** (a real caller
exists but the boundary criteria are incomplete) / **REJECTED** (a proven bypass,
or a mutation/contract problem).

## Finding 0: the graph has four write families, not one

This is the finding that governs every surface verdict, so it is stated first.

Direct callers of the `graph.js` write API across runtime source:

| Write family | Sink | Runtime callers |
|---|---|---|
| **Knowledge mutation** | `graph.addNode`, `graph.addEdge`, `graph.addTag` | `kernel.js`, `lib/learn-use-case.js`, `lib/conflict-detector.js` |
| **Audit events** | `graph.appendAuditEvent` | `kernel.js`, `server.js:87`, `lib/mcp-ingest-execute-tool.js:94`, `lib/cli-mutation-audit.js`, `agent.v3.js`, `lib/github-connector.js`, `lib/conflict-detector.js` |
| **Candidate claims** | `graph.addCandidateClaim` | `kernel.js`, `kernel.v2.js`, `lib/external-client-mutation-receipt-owner.js`, `lib/github-connector.js`, `lib/conflict-detector.js` |
| **Plugin capability writes** | `graph.addEdge` via `kernel._commitBackgroundEdge` | `kernel.runCapability` (`kernel.js:310-312`) |

**No single point covers all four.** Any statement that a surface has "one
mutation entry point" is true only within a family, and that qualification
decides most of what follows.

## Finding 1: `kernel.learn()` is a real chokepoint for the knowledge family

`kernel.js:739`. Everything in the knowledge-mutation family funnels here:

- `learnDocument` (`kernel.js:1280`) splits text into lines and calls
  `this.learn(...)` per line.
- `learnAsync` (`kernel.js:722`) prepares and calls `this.learn(...)`.

Three properties already hold at this seam and are worth recording because a
hook would inherit them:

1. **It takes a critical section** — `_enterCriticalSection('learn')`
   (`kernel.js:743`).
2. **It fails closed on missing durability** — absent
   `graph.runMutationOnce`, it throws `DURABLE_MUTATION_JOURNAL_UNAVAILABLE`
   (`kernel.js:748-751`) rather than writing.
3. **It has a pre-mutation hook point** — `_runBeforeLearn` (`kernel.js:740`)
   runs before the critical section is entered.

### But `_runBeforeLearn` is not an enforcement point

`kernel.js:441-450`: it emits the `beforeLearn` **plugin event**, and returns the
payload plugins hand back — `ev.text` and `ev.opts` are then used for the write.

It is a transform hook by design. Placing identity enforcement there would put
the gate on the same seam that plugins use to rewrite the payload, which fails
the "cannot be bypassed" criterion for a reason that has nothing to do with the
surface. **A hook at the learn seam must sit between `_runBeforeLearn` and
`_enterCriticalSection`, not inside the plugin event.**

## Per-surface measurement

### `github-app-server.js` — **REJECTED**

| Measurement | Result |
|---|---|
| Mutation reachability | **No mutation path exists.** No call to `learn`, `learnDocument`, `addCandidateClaim`, `appendAuditEvent`, `handleIngest` or `runCapability` appears in the file. |
| Pre-effect position | N/A — no effect |
| Fail-closed | N/A |
| Receipt evidence | N/A |
| Contract preservation | N/A |

Consistent with `lib/github-connector.js` being listed in
`lib/module-reachability.js::NOT_YET_WIRED` as a library-only connector.

Rejected **not because it is unsuitable but because there is nothing to
enforce.** Placing an identity boundary on a surface with no mutation path would
produce enforcement that provably never runs — which would read as coverage
while providing none. If the GitHub App later acquires a mutation path, this
verdict must be re-measured rather than inherited.

### `cli.js` — **PARTIAL**

| Measurement | Result |
|---|---|
| Mutation reachability | Knowledge family: **one call**, `this.kernel.learn(...)` at `cli.js:251`. Other families: `kernel.runCapability(...)` at `cli.js:281, 299, 310, 381`, plus the audit writes `lib/cli-mutation-gate.js` and `lib/cli-mutation-audit.js` own. |
| Pre-effect position | Achievable at the learn seam, subject to Finding 1 |
| Fail-closed | Seam already fails closed on durability; identity fail-closed unproven |
| Receipt evidence | `lib/cli-mutation-audit.js` exists as an audit writer; not yet emitting identity reasons |
| Contract preservation | Not measured — no candidate implementation to test |

The cleanest knowledge-mutation surface, and still not SUPPORTED: four
`runCapability` call sites reach `_commitBackgroundEdge` without passing the
learn seam.

### `mcpServer.js` — **PARTIAL**

| Measurement | Result |
|---|---|
| Mutation reachability | Knowledge family: **two calls**, `kernel.learn(...)` at `mcpServer.js:302` and `mcpServer.js:546`. Audit family: `lib/mcp-ingest-execute-tool.js:94` writes `graph.appendAuditEvent` directly. |
| Pre-effect position | Achievable at the learn seam |
| Fail-closed | `lib/mcp-ingest-execute-tool.js:111` already fails closed on approval (`APPROVAL_REQUIRED`), which is a working precedent for the shape |
| Receipt evidence | Ingest execute writes audit events; identity reasons absent |
| Contract preservation | Not measured |

Two learn call sites rather than one is not disqualifying — both reach the same
seam — but it means a *surface-level* hook would need two placements while a
kernel-seam hook would need none.

### `server.js` — **PARTIAL**

| Measurement | Result |
|---|---|
| Mutation reachability | The widest. Knowledge family via `kernel.learnDocument(...)` (`server.js:162`); ingest via `handleIngest` → `kernel.runCapability` (`lib/ingest.js:448`); approvals via `decideIngestApproval`; and a **direct** `kernel.graph.appendAuditEvent` at `server.js:87`. |
| Pre-effect position | Achievable per family, not per surface |
| Fail-closed | Route auth already fails closed; identity fail-closed unproven |
| Receipt evidence | Richest existing provenance/receipt surface of the four |
| Contract preservation | Not measured |

`server.js:87` is the clearest single piece of evidence for Finding 0: a
production surface writing to the graph without passing any mutation seam.

## Summary

| Surface | Verdict | Governing reason |
|---|---|---|
| `github-app-server.js` | **REJECTED** | No mutation path to enforce |
| `cli.js` | **PARTIAL** | One learn call; `runCapability` writes bypass the seam |
| `mcpServer.js` | **PARTIAL** | Two learn calls; direct audit write bypasses the seam |
| `server.js` | **PARTIAL** | Multiple families incl. a direct graph write |

**No surface measures SUPPORTED.** That is the measurement's principal result,
and it is not a failure of the surfaces — it is evidence that the criteria were
being applied to the wrong layer.

## What the evidence points at

Stated as a finding for Gate 2, **not as a decision**:

`kernel.learn()` is shared by all three mutating surfaces. A hook there would
cover the knowledge-mutation family for CLI, MCP and HTTP at once, needs no
per-surface placement, and inherits an existing critical section and an existing
fail-closed durability check.

It would **not** cover the other three write families. Any Gate 2 decision that
places the hook at the learn seam must therefore state explicitly what remains
unenforced, rather than reporting the surface as covered.

The prerequisite in either direction is Finding 1: the hook must sit after
`_runBeforeLearn` and before `_enterCriticalSection`, or plugins can rewrite the
payload the gate just approved.

## Stop conditions

Re-measure rather than reuse this document if:

- `github-app-server.js` acquires any mutation path;
- `lib/github-connector.js` leaves `NOT_YET_WIRED`;
- a new direct `graph.*` write appears in a production entry point;
- `kernel.learn` stops being the single funnel for `learnDocument`/`learnAsync`.

## Non-claims

This document does not claim that a hook has been selected, that any surface is
ready for enforcement, that identity enforcement exists, that the criteria are
satisfied anywhere, or that "contract preservation" has been measured for any
surface — no candidate implementation exists to test.
