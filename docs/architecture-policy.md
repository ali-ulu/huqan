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
| **401 – 800** | Recorded debt, with a reason and a dated review. |
| **> 800** | Decomposition is owed, with its own issue. |
| **any size** | A structural signal — a cross-module private call, a growing dispatch, a construction that should be an injection, a fan-out of 20 or more — is its own issue regardless of length. |

`scripts/check-file-size.js` enforces the first two rows as a ratchet at 400:

- A file at or under 400 may not cross it. 563 files are held there.
- A file above it may not grow. 74 are recorded at today's size.
- When one shrinks, its recorded ceiling drops to match. Gains are never
  spendable later.
- At 400 or below, its entry is removed.
- **Every recorded entry carries a reason and a review date.** Past that date
  the gate fails until someone shrinks the file or writes down why it stays and
  sets the next date. An entry with no date at all fails too, so the rule is not
  opt-in.

That last rule is the half a ratchet is otherwise missing. A ceiling that *may*
fall is not a ceiling that *must*, and an entry nobody revisits is a decision
nobody made — which is exactly how the policy this replaced froze its debt, one
threshold higher. Dates are staggered: the files that owe a decomposition come
up first.

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

The ring model (#2641) is the same graph under the four names Clean
Architecture gives it:

```
UI (0)  ->  Application (1)  ->  Adapters (2)  ->  Core (3)
```

An edge is a violation when it points from an inner ring at a more outward
one — `Core -> UI` and `Core -> Adapters` are the cases #2641 names, and
`Application -> UI` is the edge `scripts/check-layers.js` already records as
debt. Assignment is a path rule in
`scripts/architecture-dependency-graph.js`, never a fallback: a module that
matches no rule is *unassigned* and the gate fails on it. The snapshot, edges
and violations are committed in `scripts/architecture-tracker-baseline.json`
(`dependencyGraph`); `npm run arch:snapshot -- --graph` prints what the gate
sees, and `npm run check:architecture-trackers` fails on an unassigned
module, a violation that is neither recorded nor covered by a dated exception,
and graph drift past the recorded threshold (`threshold`, 50).

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
| Line ceiling may not rise | yes | `scripts/check-file-size.js`, 637 files measured |
| No require cycles | yes | `scripts/check-import-cycles.js`, 637 files measured |
| Correctness lint | yes | `npm run lint` (`oxlint`, `correctness` at error): 0 findings over 1465 files, run by the `Enforce a lint-clean tree` job in `.github/workflows/architecture.yml` |
| Banded budget (400 hard cap) | yes | `scripts/check-file-size.js`, 74 recorded entries |
| Baseline review dates | yes | both baselines; an expired or missing entry fails the gate |
| Dependency direction | yes | `scripts/check-layers.js`, 3 dated exceptions |
| Layer graph and drift | yes | `scripts/architecture-snapshot.js --check` against the `dependencyGraph` section of `scripts/architecture-tracker-baseline.json` (#2641): every module in a ring (`UI`, `Application`, `Adapters`, `Core`), directed import edges, outward edges recorded; a module with no ring, a violation that is neither recorded nor under a dated exception, and drift past the recorded threshold (50) fail the gate |
| Construction instead of injection (DIP) | yes, as a ratchet | `scripts/architecture-snapshot.js --check`: a new DIP signal fails the baseline evolution check; composition roots are exempt by path; a construction that is not a coupling defect is a dated exception in `DIP_ALLOWED` (1, #2268), and an expired or stale entry fails the gate |
| Module boundary | yes | `scripts/check-module-boundary.js`, ratcheted at 48 calls in 18 files |

No row is marked "not yet" any more. Every rule here is checked by a script or
by the linter, and every check runs in CI — a rule nothing enforces is asserted
nowhere. The correctness lint reached zero the way the other gates are required
to: 883 findings were triaged individually, not baselined. Five rules that had
been switched off globally (`no-control-regex`, `constructor-super`,
`no-unused-expressions`, `no-irregular-whitespace`, `no-useless-escape`) are
back on. Where a finding is a deliberate construction rather than a defect — a
regex naming the control characters a sanitiser strips, a derived constructor
that returns an object by design — the exemption is a directive at the site,
31 of them, each with its own reason: 25 `oxlint-disable-next-line` and 5
`oxlint-disable-line` for `no-control-regex`, and 1 `oxlint-disable-next-line`
for `constructor-super`. No rule is globally `off`. The file-size ratchet sets
that split: a directive on its own line grows four files already recorded at
their ceiling, so in those the directive rides on the annotated line.

### Kernel ↔ KernelV2 substitutability

`KernelV2` may add fields to a `Kernel` verdict but may change one only through
a named rule with one producer and a test. The rules, and what a caller may
assume holds for both, are in
[ADR-013](adr/ADR-013-kernel-v2-substitutability.md) (#2117).
`learnFromLLM` follows the same rule at the learning boundary: V2-specific
manipulation filtering is a named pre-policy in `lib/text-safety-scorer.js`,
while the wrapped Kernel remains the single owner of conflict checks,
admission and canonical learning.

## 7. Changing this policy

Through an ADR, not an edit. The failure this document replaces began as one
person's reasonable judgement written straight into a file.
