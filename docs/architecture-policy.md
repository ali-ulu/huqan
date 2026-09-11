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

A runtime source file targets **200 lines**. Files above it are debt and are
recorded in `scripts/file-size-baseline.json`.

- A file at or under 200 may not cross it.
- A file above it may not grow.
- When it shrinks, its recorded ceiling drops to match. Gains are never
  spendable later.
- At 200 or below, its entry is removed.
- **New:** every baseline entry carries a justification and a review date.
  An entry past its review date without a written decision fails the gate.

An exception above 200 is allowed where splitting would create more coupling
than it removes — a table, a generated file, a single cohesive state machine.
The exception is written down and it is reviewed, not permanent.

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
| 200-line target | **not yet** | threshold is still 800 |
| Baseline review dates | partly | present in the module-boundary baseline; not yet in `scripts/file-size-baseline.json` |
| Dependency direction | yes | `scripts/check-layers.js`, 3 dated exceptions |
| Module boundary | yes | `scripts/check-module-boundary.js`, ratcheted at 110 calls |

Rows marked "not yet" are commitments, not claims. A rule that cannot be
checked by a script does not belong in this table at all.

## 7. Changing this policy

Through an ADR, not an edit. The failure this document replaces began as one
person's reasonable judgement written straight into a file.
