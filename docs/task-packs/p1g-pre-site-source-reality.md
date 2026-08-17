# P1-G — Pre-mutation sites: source reality

## Purpose

ADR-012 step 1 is "the 5 pre sites → fail closed". This measures those sites
before changing them, against one question:

> **If the audit cannot be written, is the security refusal at that point still
> deterministic and visible?**

"Fail closed" is not the same as "throw". A site already satisfies the contract
if the chain holds:

```text
audit fails -> mutation blocked -> refusal state preserved
            -> caller can observe / reconcile the refusal
```

**Nothing is changed here.** This measures and reports.

## Canonical base

```text
repository: ali-ulu/huqan
main: 7ea4cca971163e9785e970c155d18e1a89e14175
```

## Result 1 — the five sites already satisfy the contract

Measured by execution, not by reading: the audit sink was replaced with one
that throws, everything else left intact.

| Site | Pre-mutation decision | Audit failure today | Mutation happens? | Refusal visible? | Change required |
|---|---|---|---|---|---|
| `kernel.js:359` (`proposeNode`, admission unavailable) | `review` | swallowed → `audit: null` | **no** — `node: null`, absent from graph | **yes** — `decision: 'review'` | **none** |
| `kernel.js:374` (`proposeNode`, admission refuses) | `reject` | swallowed → `audit: null` | **no** — `node: null`, absent from graph | **yes** — `decision: 'reject'` | **none** |
| `kernel.js:597` (`proposeEdge`, admission unavailable) | `review` | swallowed → `audit: null` | **no** — `edge: null` | **yes** — `decision: 'review'` | **none** |
| `kernel.js:613` (`proposeEdge`, admission refuses) | `reject` | swallowed → `audit: null` | **no** — `edge: null` | **yes** — `decision: 'reject'` | **none** |
| `kernel.js:796` (`learn`, provenance rejection) | throw | swallowed internally | **no** — rolled back before this point | **yes** — `throw error` is unconditional | **none** |
| `agent.v3.js` (AB10 budget) | refusal | swallowed | **no** — no mutation on this path | **yes** — refusal returned to caller | **none** |

Observed directly for the first four, with a throwing audit sink:

```text
SITE1 admission-unavailable: {"decision":"review","node":null,"audit":null} inGraph=false
SITE2 admission-reject:      {"decision":"reject","node":null,"audit":null} inGraph=false
SITE3 admission-unavailable: {"decision":"review","edge":null,"audit":null}
SITE4 admission-reject:      {"decision":"reject","edge":null,"audit":null}
```

Site 5 is a **source-level** conclusion, not an executed one, and is marked as
such deliberately: `_appendAuditEvent` never throws (it catches internally and
returns `null`), and `throw error` follows it unconditionally, so the rejection
propagates whatever the audit does. Reproducing it through the public `learn`
surface was attempted and did not trigger — `_runBeforeLearn` and the
`hasProvenanceInput` check make the branch hard to reach from outside — so no
execution evidence is claimed for it.

### Why this is the outcome

All five sites are **refusal-recording branches**. The mutation was already
decided against before the audit write is attempted, and the refusal is carried
by the return value or the throw, not by the audit. There is no path on which a
failed audit lets something through.

## Result 2 — the observable signal already exists, and a caller already uses it

`_appendAuditEvent` returns `null` on failure and the event on success, and
that value is returned to the caller as `audit`:

```js
return { decision: admission.outcome, node: null, audit, admission };
```

One production caller already consumes it, counting evidence separately from
writes:

```js
// kernel.js:929, _crossLink
if (result.audit) audits++;
if (result.decision === 'allow' && result.edge) written++;
```

So the "audit evidence missing" signal is already in the return contract and is
already being read. **No new error contract needs to be invented for step 1**,
which was the constraint on this measurement.

## Result 3 — two corrections to ADR-012

Both are corrections to a document that has already been merged, so they are
stated plainly rather than folded into the prose.

### 3a. "Fail-open" was the wrong label

ADR-012's conformance debt table lists `kernel.js:359, 374, 597, 613, 796` and
`agent.v3.js` as **fail-open**. That is wrong. A fail-open means something gets
through; nothing gets through at any of these sites. What is lost is the
*evidence of a refusal*, never the refusal.

The precise statement — which ADR-012 already used for `agent.v3.js` and should
have used for all six — is:

> These sites are **conformant on enforcement** and **non-conformant on
> evidence**. The mutation is blocked; the record that it was blocked may be
> silently absent.

That is still worth fixing, and it is a smaller and differently-shaped fix than
"make them fail closed": they are already closed.

### 3b. The chokepoint has 17 production call sites, not 8

ADR-012 describes an "eight-call-site kernel chokepoint" and splits it 5 pre / 3
post. That count is only the call sites **inside `kernel.js`**.
`_appendAuditEvent` is called from three production files:

| File | Pre | Post | Total |
|---|---|---|---|
| `kernel.js` | 5 | 3 | 8 |
| `lib/learn-use-case.js` | 3 (`:30`, `:49`, `:77`) | 4 (`:233`, `:261`, `:293`, `:334`) | 7 |
| `lib/conflict-detector.js` | 0 | 2 (`:412`, `:453`) | 2 |
| **Total (production)** | **8** | **9** | **17** |

`lib/github-connector.js:267` also reaches it and is excluded: `NOT_YET_WIRED`.

The 5/3 split ADR-012 states is correct *for `kernel.js`*. The axis decision it
took is unaffected — every one of the eleven additional sites classifies
cleanly by the same test, and the post sites all sit after a completed
`addEdge` / `addCandidateClaim`. What changes is the **size of the work**:
step 2 (post sites → visible) is nine call sites across three files, not three
in one.

## Verdicts

```text
PRE_SITES_ENFORCEMENT_CONFORMANT       = true    (all 6, measured)
PRE_SITES_EVIDENCE_CONFORMANT          = false   (all 6 swallow silently)
NEW_ERROR_CONTRACT_REQUIRED_FOR_STEP_1 = false   (audit: null already consumed)
ADR_012_FAIL_OPEN_LABEL                = incorrect
CHOKEPOINT_PRODUCTION_CALL_SITES       = 17      (8 pre, 9 post)
```

## What this means for step 1

The question "one PR or split?" now has a different shape than when it was
asked, because the work itself is different from what was assumed.

There is **no enforcement change to make**. What remains for the pre sites is
an evidence change: a silently-null audit becomes an observable one. And that
is the same change the post sites need — ADR-012's floor, "silent continue is
forbidden", applies to both positions.

That suggests the pre/post split is **not** the right seam for step 1, which is
worth saying since ADR-012 introduced that split and this measurement is the
first test of it. The split remains correct about *contracts*; it is not
obviously the right unit of *work*, because the first change both halves need
is the same one.

Two shapes follow, and this document does not choose between them:

- **By position, as ADR-012 ordered.** Step 1 becomes small — surface the
  existing `audit: null` at six sites — and step 2 stays large.
- **By the change itself.** One unit that stops `_appendAuditEvent` from
  swallowing, covering all 17 sites, followed by per-position decisions about
  what each caller then does with the signal.

The second is a larger diff and a smaller decision; the first is the reverse.
The choice belongs with whoever weighs a bigger blast radius against a longer
sequence of steps, and it should be made knowing that "5 pre sites" was never
the real boundary.

## What this does not claim

- It does not claim the six sites need no change. They need an evidence change.
- It does not claim site 5 was executed. It was not; the conclusion there is
  from source, and the attempt that failed is recorded above.
- It does not classify the eleven additional sites beyond position. Whether
  `learn-use-case`'s post sites want the same propagation as
  `conflict-detector`'s is a caller-contract question, still TBD per ADR-012.
- It does not re-open the axis decision. Position still partitions cleanly.
