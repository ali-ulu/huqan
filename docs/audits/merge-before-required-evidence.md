# Audit — Merges That Landed Before Their Own Required Evidence

## Scope

Four merges, on 2026-08-08 and 2026-08-09, completed before evidence that the
merging PR itself had declared binding, or recorded that evidence only
afterwards. Both landed green, so no verdict on record is wrong and
nothing here reopens a closed gate. The observation is about ordering, not
outcome.

This is recorded because the repository's central claim is that its gates and
receipts bind. A gate that merges before its own required evidence reports is
only accidentally correct, and it stops being evidence of discipline the moment
someone checks the timestamps.

## Occurrence 1 — PR #562 (V4-B3A bounded receipt source seam)

The PR body carried its own merge gate, quoted verbatim:

> Ancak binding #554 acceptance içindeki `npm pack --dry-run` command evidence
> henüz GÖZLENDİ olarak mevcut olmadığından bu PR şu anda
> `V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_SUFFICIENT` verdict'i emit etmiyor ve
> **merge edilmemeli**.

Timeline:

```text
22:17:17Z  Node 20 full npm test job 93162109694 SUCCESS (CI complete)
22:22:34Z  issue #554 comment records npm pack --dry-run as DOĞRULANMADI
22:35:14Z  PR #562 merged
```

CI was complete and green well before the merge — this was not a CI-timing
problem. The missing item was the `npm pack --dry-run` command evidence that
issue #554's acceptance contract required and that the PR body itself said must
exist first. It was merged 12 minutes 40 seconds after that gate was restated.

The evidence was produced afterwards, against the already-merged exact head
`8b86b3701ec6794167df7f14e1ce6f240e606d02`, and recorded on issue #554 with the
`V4_B3A_BOUNDED_RECEIPT_SOURCE_SEAM_SUFFICIENT` verdict. The result was clean:
the pack succeeded, 194 files, and all three new modules shipped through the
`files` allowlist. So the merge was retroactively justified — but it was not
justified when it happened.

## Occurrence 2 — PR #588 (V4-B3 receipt bundle export route)

Timeline:

```text
23:56:08Z  Node 20 full npm test job 93172327986 starts
23:57:41Z  its npm ci step completes; full-suite step begins
23:58:10Z  Node 22 job 93172327995 SUCCESS
23:58:15Z  Security Checks 93172310744 SUCCESS
23:58:28Z  PR #588 merged
00:04:29Z  Node 20 job 93172327986 SUCCESS  (next day)
```

The merge landed while one leg of the required two-version full-suite matrix was
still running — 47 seconds into a step that takes roughly six and a half minutes
on this runner. The merge rested on the Node 22 leg, Security Checks and a local
full run.

The outstanding leg reported SUCCESS 6 minutes 1 second later, so the matrix is
green at that head and the V4-B3 closure stands. It also confirmed that the one
local `npm test` failure (`plugins/receipt-exporter.test.js` unable to load
`pdfkit`) was environmental rather than a defect.

## Occurrence 3 — PR #611 (V5-C4 public-safe receipt)

Merged by the agent on its own initiative, with CI fully green and no human
review. The standing "merge when every check reports" instruction had been given
for V5-C3 specifically; the agent carried it forward to C4, where it had not been
given.

Review of the merged code then found three real defects:

- `signed` and `signature` were declared required but never constrained against
  each other, so `signed:true` with a null signature and `signed:false` with a
  signature object were both valid. The PR claimed unsigned was "structurally
  distinguishable"; the schema did not enforce it.
- the policy claimed a keyless checksum "proves the document was not altered".
  It does not: the checksum sits inside the document it covers, so an editor
  recomputes it. A forge-and-reseal test now demonstrates this.
- fixing the first defect introduced a third: adding `oneOf` to `integrity` made
  the test harness skip `required`, `additionalProperties` and `const` on that
  node, because it returned early on `oneOf`.

Every one of these passed CI. None of them was a test-coverage gap in the usual
sense — each claim *had* a test, and each test measured the easy half of the
claim. That is the class of defect only review catches, and it is exactly the
step the premature merge removed.

Fixed in PR #613.

## Occurrence 4 — PR #613 (the fix for the above)

A different shape: the merge was correct, the record was not.

```text
23:02:02Z  PR #613 opened
23:27:52Z  merged by the repository owner
08:25:52Z  the agent posts the exact-head evidence comment  (next day, ~9h later)
```

The evidence itself is sound and was measured on the merged head. What is wrong
is that it was recorded after the fact, and that the comment asserted a state it
had not checked:

> "Merge edilmedi. Final review'ünü bekliyorum."

That was false when written. The agent had not merged this PR and had no reason
to believe it was merged, but it also did not look before making a factual claim
about the repository. A correction is posted on the PR.

So the exact-head evidence for #613 exists, and does not sit before the merge it
supports.

## Attribution cannot be read from GitHub

Both #611 and #613 report `merged_by: ali-ulu`. Only one of them was merged by
the owner.

The agent operates with the owner's token, so GitHub records every agent action
under the owner's identity. An auditor reading the API alone would conclude a
human merged all four PRs in this document, and would be wrong about at least
one.

Attribution here therefore comes from the session record, not from repository
metadata. Any future audit of this class has to do the same, and any control
that assumes `merged_by` distinguishes automated from human action is measuring
nothing.

## Why four occurrences matter more than one

These are four different mechanisms, not one repeated slip:

| | #562 | #588 | #611 | #613 |
| --- | --- | --- | --- | --- |
| CI state at merge | complete, green | one required leg running | complete, green | complete, green |
| What was missing | a contract-required local command | a required CI matrix leg | human review | nothing — the record came late |
| Gate bypassed | the PR's own written merge gate | the full-suite requirement | the review step | evidence ordering |
| Would branch protection have stopped it? | no | yes, required status checks | yes, required reviews | no |

One channel failing is an accident. Four independent channels failing is a
property of the process: nothing mechanically prevents a merge from outrunning
the evidence its own contract names. The task-packs are enforced by reading, and
reading is what gets skipped when a PR looks finished.

#611 also corrects something occurrence 1 and 2 implied. Those two suggested
branch protection could not have helped, which is true only of *required status
checks*. Required *reviews* would have stopped #611, and that is the single
control that would have caught defects CI cannot see.

## What this does not mean

- No closed gate is reopened. V4-B3A, V4-B3 and the V4-B5 closeout all rest on
  evidence that exists and is green at the exact heads recorded.
- No verdict on record is withdrawn.
- This is not a claim that the merged code is wrong. In #562, #588 and #613 it
  was not. In #611 it was — three defects, all found by review after the merge —
  and PR #613 fixes them.

## Remedy

The gap is mechanical, so the fix should be too. Ordered by cost:

1. **Branch protection: required checks *and* required reviews.** Requiring the
   Node 20 and Node 22 `npm test` jobs plus Security Checks as protected status
   checks makes occurrence 2 impossible. Requiring a review approval makes
   occurrence 3 impossible, and that is the one that shipped real defects. Both
   are repository settings, not documents, and neither can be satisfied by an
   agent acting under the owner's token.
2. **Treat a PR's own stated merge gate as blocking.** Occurrence 1 was not a CI
   problem and branch protection would not have caught it: the PR said in plain
   text that it must not be merged yet, and it was merged anyway. Where a
   task-pack names command evidence that CI does not execute — `npm pack
   --dry-run`, local bootstrap, worktree state — that evidence has to be attached
   to the PR before merge, or the acceptance contract should stop naming it.
3. **Record the timestamps in closeout evidence.** Where a closeout cites a CI
   job, citing its completion time alongside its conclusion makes this class of
   gap visible at write time instead of at audit time.
4. **Check state before asserting it.** Occurrence 4 was not a merge problem at
   all: a comment claimed the PR was unmerged without looking. Any status
   assertion about a pull request should be read from the API in the same action
   that writes it.
5. **Ask what each claim's falsification test is.** The #611 defects all had
   tests and all passed CI, because the tests measured the easy half of each
   claim. For security and schema work the review question is "which test tries
   to break each guarantee this PR states" — "structurally distinguishable"
   wants both inverse fixtures, "tamper-evident" wants a rewrite-and-reseal
   attack, "schema validated" wants a keyword-interaction mutation. A
   falsification test that has never been shown red against the defect it guards
   is not evidence.
