# P1-H — `_appendAuditEvent` evidence propagation: source reality

## Purpose

The migration unit was chosen by the **shared defect** rather than by position:
`_appendAuditEvent` swallows audit failures silently, and that affects every
call site behind it.

Before applying a common minimum contract, this measures those call sites:
what they are, which position each occupies, how each caller consumes the audit
result, and what actually happens today when the audit fails.

**Nothing is changed here.** Steps 1–4 of the agreed order; step 5 is a
separate diff.

## Canonical base

```text
repository: ali-ulu/huqan
main: cf671c569cadc6c7f87480aca48d845eb2e7c88b
```

## Correction — 17 was an undercount; there are 21

`docs/task-packs/p1g-pre-site-source-reality.md` reported 17 production call
sites. That counted *textual* `_appendAuditEvent(` occurrences, and one of them
is not a write: `lib/conflict-detector.js:224` is a pass-through helper,
`appendAudit()`, with **four further callers of its own**. Each of those is a
distinct audit write that reaches the chokepoint.

```text
p1g reported:  17 call sites   (8 pre,  9 post)
actual:        21 audit writes (8 pre, 13 post)
```

The axis decision is again unaffected — all four additional writes are
post-mutation. The correction is to the scale, for the second time in two
measurements, which is itself worth noting: this chokepoint's reach has been
underestimated at every previous count because it is reached through three
files and one indirection.

## The 21 sites

| # | Site | Position | Result bound? | Reaches caller? |
|---|---|---|---|---|
| 1 | `kernel.js:359` `proposeNode`, admission unavailable | pre | **yes** | yes — `audit` in return |
| 2 | `kernel.js:374` `proposeNode`, admission refuses | pre | **yes** | yes — `audit` in return |
| 3 | `kernel.js:392` `proposeNode`, after `addNode` | post | **yes** | yes — `audit` in return |
| 4 | `kernel.js:597` `proposeEdge`, admission unavailable | pre | **yes** | yes — `audit` in return |
| 5 | `kernel.js:613` `proposeEdge`, admission refuses | pre | **yes** | yes — `audit` in return |
| 6 | `kernel.js:641` `proposeEdge`, after `addEdge` | post | **yes** | yes — `audit` in return |
| 7 | `kernel.js:796` `learn`, provenance rejection | pre | no | no |
| 8 | `kernel.js:912` `_crossLink`, after `addEdge` | post | no | no |
| 9 | `learn-use-case.js:30` rejection re-append | pre | no | no |
| 10 | `learn-use-case.js:49` admission refuses | pre | no | no |
| 11 | `learn-use-case.js:77` strictProvenance rejection | pre | no | no |
| 12 | `learn-use-case.js:233` after `addEdge` | post | no | no |
| 13 | `learn-use-case.js:261` after `addEdge` | post | no | no |
| 14 | `learn-use-case.js:293` after `addEdge` | post | no | no |
| 15 | `learn-use-case.js:334` after `addEdge` | post | no | no |
| 16 | `conflict-detector.js:412` after `addCandidateClaim` | post | no | no |
| 17 | `conflict-detector.js:453` inside `runMutationOnce`, after writes | post | no | no |
| 18 | `conflict-detector.js:549` via `appendAudit`, after `addNode`/`addEdge` | post | no | no |
| 19 | `conflict-detector.js:570` via `appendAudit`, after `addCandidateClaim` | post | no | no |
| 20 | `conflict-detector.js:589` via `appendAudit`, after `addCandidateClaim` | post | no | no |
| 21 | `conflict-detector.js:603` via `appendAudit`, after writes | post | no | no |

`lib/github-connector.js:267` also reaches the chokepoint and is excluded:
`NOT_YET_WIRED`.

## Result 1 — the defect is not only in the chokepoint

**Six of twenty-one sites bind the return value. Fifteen discard it.**

This is the finding that decides the shape of step 5. Making
`_appendAuditEvent` stop swallowing is **necessary and not sufficient**: at
fifteen sites there is no receiver for the signal it would start producing. A
change confined to the chokepoint would improve nothing observable at those
fifteen.

The six that bind it are all in `kernel.js`'s `proposeNode` / `proposeEdge`,
and they already propagate it to the caller as `audit`.

## Result 2 — how callers consume it today

| Consumer | What it reads | Evidence-aware? |
|---|---|---|
| `kernel.js:929` `_crossLink` | `if (result.audit) audits++` | **yes** — counts evidence separately from writes |
| `kernel.js:1144` `_autoThinkTick` | `result.decision`, `result.edge` | no |
| `kernel.js:1251` `dream` | `result.decision`, `result.edge` | no |
| `kernel.js:1471` `selfEvolve` | `result.decision`, `result.edge` | no |
| `lib/connectors/entry-ingest-flow.js` | `proposeNode` result | no |
| `plugins/company-brain.js`, `plugins/repo-memory.js` | `proposeNode` / `proposeEdge` results | no |

So exactly **one** production consumer is evidence-aware, and it is the one
that already motivated "no new error contract is required" in P1-G. That
statement remains true — `audit` exists in the return shape — but its reach is
one caller out of six, and zero of the fifteen unbound sites.

## Result 3 — triggered verification: the loss is currently invisible

Measured by running the paths with a throwing audit sink, everything else
intact.

**Candidate ingest** (`kernel.ingestCandidateClaim`, reaching sites 16–21):

```text
working sink: {"keys":["candidate","conflict","warnings","admission","mutation"],"hasAuditField":false}
dead sink   : {"keys":["candidate","conflict","warnings","admission","mutation"],"hasAuditField":false}
```

**Learn** (`kernel.learn`):

```text
learn working: {"type":"learn","ok":true,"hasAudit":false}
learn dead   : {"type":"learn","ok":true,"hasAudit":false}
```

Identical in both cases. On these paths a total audit-sink failure produces **no
observable difference at all** — no field, no flag, no changed status.

One limit on the learn measurement, stated rather than glossed: the fact
extractor returned `learned: 0` for every phrase tried in this configuration,
so that run exercises the learn entry path but **does not confirm that sites
12–15 were reached**. What it does show is that the learn surface reports
nothing about audit evidence in either case, which is the claim being made.

That a correct, admitted write lands while its evidence vanishes is shown
separately and directly, through `proposeNode`:

```text
decision: 'allow'   node: written and durable   audit: null
```

This is ADR-012's forbidden B3 in its strongest form, and it is worth being
exact about the severity rather than rounding it up: the writes are correct and
admitted, and nothing unauthorized happens. What is unavailable is any way for
a caller — or an operator reading a response — to know the evidence is missing.

## Verdicts

```text
CHOKEPOINT_AUDIT_WRITES              = 21     (8 pre, 13 post)
RESULT_BOUND_AT_CALL_SITE            = 6
RESULT_DISCARDED_AT_CALL_SITE        = 15
EVIDENCE_AWARE_CONSUMERS             = 1
LOSS_OBSERVABLE_ON_LEARN_PATH        = false
LOSS_OBSERVABLE_ON_CANDIDATE_PATH    = false
CHOKEPOINT_FIX_ALONE_IS_SUFFICIENT   = false
```

## What step 5 has to be, given this

The agreed contract stands and is not re-opened:

| Position | Audit failure | Required |
|---|---|---|
| pre | mutation has not happened | fail-closed |
| post | mutation has happened | visible |
| post propagation | — | per caller contract |

Two things follow from the measurement, and only the second is a choice.

**Not a choice:** step 5 cannot be a change to `_appendAuditEvent` alone. The
minimum viable unit is the chokepoint **plus** a receiver at each site that
currently discards the result. Anything less leaves fifteen sites exactly as
they are.

**A choice, and not made here:** what the fifteen receivers should be. Three
observations bound it without settling it.

- The eight pre sites are already fail-closed on enforcement (P1-G, measured),
  so what they need is evidence propagation, not a new refusal.
- Seven of the thirteen post sites sit inside `runMutationOnce` or a loop that
  aggregates (`learned++`, `written++`); a per-write throw there would abort a
  batch that has already partly committed, which is the "do not undo" half of
  the contract violated in the other direction.
- `_crossLink` shows a working shape for aggregating paths: count evidence
  separately and report the count. It is the only existing precedent, and it is
  a precedent for *counting*, not for throwing.

That third point is the reason not to decide it here: one precedent across
twenty-one sites is thin evidence for a general rule, and this measurement has
now corrected the site count twice. The receivers should be designed against
the caller contracts, which is what ADR-012 left open on purpose.

## What this does not claim

- It does not claim the fifteen sites should throw. The measurement argues
  against it for at least seven of them.
- It does not claim the six bound sites are finished. `audit` reaching the
  caller is not the same as a caller acting on it; five of six consumers ignore
  it.
- It does not re-open the axis. All four newly-found writes are post-mutation
  and classify cleanly.
- It does not measure `lib/github-connector.js`. It is `NOT_YET_WIRED`, and if
  that changes its writes join this table.
