# P1-K — The four batch callers, measured on the five questions

## Purpose

`_crossLink` is fixed (#906). This measures the four remaining
evidence-unaware callers against the five questions agreed for them, before any
is changed.

```text
1. does `warnings` actually reach the outside?
2. what outcome does an audit failure produce?
3. how is the batch's mutation result preserved?
4. how are multiple audit failures represented in one result?
5. which of the existing retrySafe / reconciliation vocabulary actually fits?
```

**Nothing is changed here.** Two of the answers are negative and they change
what the implementation should be, so they are reported before anything is
built on the assumption they were positive.

## Canonical base

```text
repository: ali-ulu/huqan
main: a1a38ef4976ad213a5dec0a03000d0adb3343c74
```

Remaining after #906: **14 discarded sites across 4 callers.**

| Caller | Sites | Production entry |
|---|---|---|
| `kernel.js` `learn` | 1 | `kernel.learn` — reachable |
| `lib/learn-use-case.js` `executeLearn` | 7 | via `kernel.learn` — reachable |
| `lib/conflict-detector.js` `acceptCandidateClaimJournaled` | 2 | via `kernel.ingestCandidateClaim` |
| `lib/conflict-detector.js` `routeCandidateClaim` | 4 | via `kernel.ingestCandidateClaim` |

## Answer 1 — the `warnings` channel is not a general channel

P1-I Result 4 said "three of four already return a `warnings` channel", and
concluded from that that no new abstraction is needed. The channel exists. It
is **already owned by something else**, which P1-I did not check.

| Caller | Field | What it currently carries |
|---|---|---|
| `routeCandidateClaim` | `warnings: built.warnings` | candidate-builder validation warnings |
| `acceptCandidateClaimJournaled` | `warnings: built.warnings` | same |
| `executeLearn` | `provenanceWarnings` | provenance policy warnings, and it is named for that |

Putting an audit-evidence gap into `provenanceWarnings` would say that failing
to persist evidence is a provenance warning. It is not — the whole ADR-012
distinction is that a security decision and the persistence of its evidence are
different things, and this would merge them in the one place a consumer looks.

**So the conclusion P1-I drew from Result 4 does not hold.** Its correction to
the plan — do not build a common accumulation seam — still stands, and stands
for a better reason than the one given: not "each caller already has a channel"
but "each caller needs its own *new* field, and four small fields are still not
an abstraction".

```text
WARNINGS_CHANNEL_EXISTS      = true
WARNINGS_CHANNEL_IS_GENERAL  = false
REUSE_WITHOUT_CONFLATION     = false
```

## Answer 2 — the audit failure produces nothing, measured

`kernel.learn` with a real admitted write, against a throwing audit sink and
everything else intact:

```text
live: {"auditAttempts":1,"learned":1,"ok":true,"warnings":2}
dead: {"auditAttempts":1,"learned":1,"ok":true,"warnings":2}
```

Identical. `ok: true`, the edge is durable, and nothing anywhere in the result
names the missing evidence. This is the same B3 the earlier measurements found,
now confirmed on a learn that actually learns rather than one that extracted no
facts — which is what P1-H could not do and said so.

## Answer 3 — the mutation result is preserved and must stay that way

`learned` counts committed edges and is unaffected by the audit outcome. The
durable write happens inside `runMutationOnce` when `kernel.learn` drives it
(`_durableMutationTransaction: true`), and the audit append is not part of that
transaction's success condition.

That is the correct arrangement under ADR-012 and must not change: the mutation
is committed, so it must not be undone. The only thing to add is that its
evidence gap becomes visible.

## Answer 4 — the multi-failure case is not reproducible here

This is the question the batch decision was designed around: "accumulate during,
one visible result at the end". It assumes a batch can produce several audit
writes.

Measured across six sequential learns on an accumulating graph:

```text
kedi hayvandir  -> learned 1, auditWrites 1
kopek hayvandir -> learned 1, auditWrites 1
kedi memelidir  -> learned 1, auditWrites 1
kopek memelidir -> learned 1, auditWrites 1
kus hayvandir   -> learned 1, auditWrites 1
kus ucar        -> learned 1, auditWrites 1
```

**One audit write per learn, every time.** `executeLearn`'s seven sites are
alternative branches on one path, not a loop that fires many.

The multi-write case is structurally possible — a learn calls `_crossLink`,
which audits per derived edge — but it did not trigger in any sequence tried,
so no evidence is claimed for it. Stated as a limit rather than assumed away:
these are the sequences I could construct, not a proof that none exists.

What follows if it holds: **accumulation is over-engineering for this caller.**
A single count, or even a boolean, carries everything a learn result can say.
The batch decision remains right for the shape it was made for; it is just not
the shape `executeLearn` turns out to have.

## Answer 5 — the vocabulary fits; the transport does not

Unchanged from P1-I and re-confirmed: `AUDIT_EVIDENCE_MISSING`, `retry: false`,
"committed, not undone" are the right words. `auditEvidenceGap`'s 409 shape is
not reusable because none of these callers is at a transport boundary.

`retrySafe: false` in particular carries over exactly: re-running a learn whose
audit failed would duplicate a committed edge, which is the same hazard the
ingest path names.

## The finding that reorders the work

**Two of the four callers have no production entry at all.**

`kernel.ingestCandidateClaim` is called from `kernel.v2` (a pass-through) and
from tests. Nothing else. `/api/candidate-claims` is a **read** endpoint —
`queryCandidateClaims` — not an ingest. `routeCandidateClaim`'s only other
caller is `lib/github-connector.js`, which is `NOT_YET_WIRED`.

So six of the fourteen remaining sites sit behind an entry no production caller
reaches. Making them evidence-aware is still right for consistency, but there
is **no live consumer to derive a caller contract from**, and ADR-012 left the
propagation shape to be decided per caller contract. Deciding it for a caller
that has none would be inventing a requirement.

```text
LEARN_PATH_PRODUCTION_REACHABLE      = true
CANDIDATE_PATH_PRODUCTION_REACHABLE  = false
SITES_BEHIND_A_LIVE_ENTRY            = 8 of 14
```

## What the evidence supports next

**The learn path, and the smallest step in it first.**

`executeLearn` calls `_crossLink` at `lib/learn-use-case.js:325` and discards
its return value. That return is now trustworthy — #906 made its counter stop
lying — so the first evidence a learn batch can honestly carry is already
sitting there, unread.

That makes #906 load-bearing rather than tidy, and it makes the next unit
small: read the value that already exists before adding a field for values that
do not.

Then the rest of `executeLearn`, with a field of its own rather than
`provenanceWarnings`.

The candidate path should wait. Not because it is hard, but because its
contract has no consumer to answer to, and this sequence has repeatedly been
right to measure before choosing.

## What this does not claim

- It does not claim a learn can never produce multiple audit writes. It claims
  none of the sequences tried did, and marks that as a limit.
- It does not re-open ADR-012 or the batch decision. Both hold; the batch shape
  simply does not describe `executeLearn`.
- It does not claim the candidate path is dead code. It is reachable and
  tested; it has no *production entry*, which is a different statement.
- It does not decide the new field's name or shape.
