# HUQAN — Architecture Policy

**Status:** binding. Supersedes the big-file refactor gate, deleted 2026-09-11.
**Measured at:** `dc51e65a`, 2026-09-11. 608 runtime files, 123.494 lines.

---

## 1. Why the previous policy was removed

The deleted document forbade splitting a large file except
immediately before a runtime PR that had to edit it heavily, and classified
`kernel.js` as "do not touch speculatively". `scripts/check-file-size.js`
cites that document as the reason its threshold is 800 rather than a real
budget.

The rule is defensible in isolation and wrong in aggregate. A ratchet that
only says "no worse than today" has no downward pressure: a ceiling that may
fall is not a ceiling that must. Measured over a year the debt did not shrink
to the target, it froze at whatever it happened to be. 207 of 608 runtime
files are over 200 lines.

This policy keeps the ratchet mechanism — it is sound — and adds the missing
half: a ceiling that is required to fall on a schedule, with a named owner
per entry.

## 2. The budget

Length is an alarm, not a defect. A file is worth splitting when something
about it is wrong — a boundary it reaches across, a dispatch that grows with
every feature, a fan-out that says it does several jobs. Length only makes
those more likely; it does not stand in for them. The first version of this
document set a flat 200-line target, which classified 207 files as debt: 177
of them had no signal against them other than their size. Chasing those down
would trade cohesive files for coupled ones and call it progress.

So the budget is banded:

| Size | Treatment |
|---|---|
| **≤ 400** | Accepted as it stands. The gate's job is to keep it there. |
| **401 – 800** | Recorded debt. Reviewed when something else brings the file into play. |
| **> 800** | Decomposition is owed, with its own issue. |
| **any size** | A structural signal — a cross-module private call, a growing dispatch, a construction that should be an injection, a fan-out of 20 or more — is its own issue regardless of length. |

`scripts/check-file-size.js` enforces the first two rows as a ratchet at 400:

- A file at or under 400 may not cross it. 542 files are held there.
- A file above it may not grow. 75 are recorded at today's size.
- When one shrinks, its recorded ceiling drops to match. Gains are never
  spendable later.
- At 400 or below, its entry is removed.

This is stricter than what it replaces, not looser: the threshold was 800,
so a 250-line module could triple in silence. It cannot now.

An exception above the band is allowed where splitting would create more
coupling than it removes — a table, a generated file, a single cohesive state
machine. The exception is written down and it is reviewed, not permanent.

## 3. Dependency direction

```
entrypoint (cli, server, mcpServer)  ->  use case  ->  domain  ->  storage
```

Arrows point one way. Storage does not reach back into domain; domain does
not import an entrypoint. 

## 4. Module boundary

A module calls another module's public surface only. Reaching into another
object's `_private` member across a module boundary is not permitted: the
member is either part of the contract and should be named as such, or it is
not and should not be called. 110 such calls exist today across 32 files;
they are debt on the same burn-down terms as line count.

## 5. Refactor rules

Unchanged from the previous document, because they were the good part:

- No behavior change. Public API unchanged. Same test pass/fail set.
- A refactor PR is not a feature PR. If a split forces a behavior decision,
  stop — that decision belongs to a runtime PR.
- No `git add .`.

Changed: a refactor no longer needs a runtime PR to justify it. Closing
recorded debt is itself sufficient justification, because the burn-down
schedule makes that closure obligatory rather than optional.

## 6. What is enforced today, and what is not

Honesty about this is the point of the document; the previous one claimed a
gate where it had a freeze.

| Rule | Enforced | By |
|---|---|---|
| Line ceiling may not rise | yes | `scripts/check-file-size.js` |
| No require cycles | yes | `scripts/check-import-cycles.js` |
| Correctness lint | **not yet** | `npm run lint` exists and reports 883 findings; not wired into CI until they are triaged |
| Banded budget (400 hard cap) | yes | `scripts/check-file-size.js`, 75 recorded entries |
| Baseline review dates | partly | present in the module-boundary baseline; not yet in `scripts/file-size-baseline.json` |
| Dependency direction | yes | `scripts/check-layers.js`, 3 dated exceptions |
| Module boundary | yes | `scripts/check-module-boundary.js`, ratcheted at 110 calls |

Rows marked "not yet" are commitments, not claims. A rule that cannot be
checked by a script does not belong in this table at all.

## 7. Changing this policy

Through an ADR, not an edit. The failure this document replaces began as one
person's reasonable judgement written straight into a file.
