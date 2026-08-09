# Audit — Merges That Landed Before Their Own Required Evidence

## Scope

Two merges on 2026-08-08 completed before evidence that the merging PR itself
had declared binding. Both landed green, so no verdict on record is wrong and
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

## Why two occurrences matter more than one

The two are different mechanisms, not one repeated slip:

| | #562 | #588 |
| --- | --- | --- |
| CI state at merge | complete, green | one required leg still running |
| Missing evidence | a contract-required local command | a required CI matrix leg |
| Gate that was bypassed | the PR's own written merge gate | the acceptance contract's full-suite requirement |

One channel failing is an accident. The same failure mode arriving through two
independent channels within four hours is a property of the process: nothing
mechanically prevents a merge from outrunning the evidence its own contract
names. The task-packs are enforced by reading, and reading is what gets skipped
when a PR looks finished.

## What this does not mean

- No closed gate is reopened. V4-B3A, V4-B3 and the V4-B5 closeout all rest on
  evidence that exists and is green at the exact heads recorded.
- No verdict on record is withdrawn.
- This is not a claim that the merged code is wrong. In both cases it was not.

## Remedy

The gap is mechanical, so the fix should be too. Ordered by cost:

1. **Branch protection on required checks.** Requiring the Node 20 and Node 22
   `npm test` jobs plus Security Checks as protected status checks makes
   occurrence 2 impossible rather than discouraged. This is a repository setting,
   not a document.
2. **Treat a PR's own stated merge gate as blocking.** Occurrence 1 was not a CI
   problem and branch protection would not have caught it: the PR said in plain
   text that it must not be merged yet, and it was merged anyway. Where a
   task-pack names command evidence that CI does not execute — `npm pack
   --dry-run`, local bootstrap, worktree state — that evidence has to be attached
   to the PR before merge, or the acceptance contract should stop naming it.
3. **Record the timestamps in closeout evidence.** Where a closeout cites a CI
   job, citing its completion time alongside its conclusion makes this class of
   gap visible at write time instead of at audit time.
