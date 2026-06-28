# HUQAN Work Protocol

> Models generate. Agents act. Memory stores. **HUQAN judges.**

HUQAN Work Protocol is the engineering operating system for HUQAN / AXIOM development.

It exists to prevent fake completeness, untested claims, uncontrolled agent changes, memory contamination, and product claims that are not backed by repository evidence.

This protocol applies to every HUQAN work item, including:

- runtime fixes
- security hardening
- MCP changes
- memory changes
- connector work
- product console work
- documentation that affects product claims
- release preparation
- roadmap checkpoint updates

---

## 1. Core Principle

**HUQAN work is not closed by intention.**
**HUQAN work is closed only by evidence.**

A work item is **not done** because:

```
it looks done
the agent says it is done
tests probably pass
the code seems simple
the UI appears to work
the README says it works
```

A work item is **done** only when:

```
repo-backed evidence exists
behavior is tested
product behavior is connected
scope stayed narrow
forbidden claims are absent
Trust / provenance / gate impact is understood
dirty root was not touched
review gate passed
```

---

## 2. Canonical Work Flow

Every HUQAN work item follows this flow:

```
audit
→ failing evidence
→ task pack
→ implementation
→ review
→ verification
→ closeout
```

No step should be skipped.

- If a task has no failing evidence, it is probably not ready for implementation.
- If a task has no acceptance criteria, it is probably not scoped.
- If a task has no test, it is probably not closeable.
- If a task has no product behavior, it may be a library change, but it must not be marketed as a product feature.

---

## P-01 — CORE-AUDIT Protocol

### Purpose

CORE-AUDIT finds:

- skeleton modules
- stub behavior
- fake completeness
- runtime gaps
- test gaps
- product flow gaps
- orphan capabilities
- misleading README or product claims

CORE-AUDIT runs before a work item becomes an implementation task.

### What CORE-AUDIT Hunts

CORE-AUDIT must explicitly look for:

```
1. Skeleton / stub modules
2. Fake completeness — tests exist but behavior is not proven
3. Runtime disconnect — module exists but product flow does not use it
4. Test gaps — assertions do not prove the product claim
5. Orphan capability — built feature is not connected to CLI/API/MCP/UI
6. Forbidden claims — docs say more than code proves
7. Memory contamination risk
8. Dirty root / unrelated drift
9. Connector or MCP path bypass
10. Trust/provenance/receipt gaps
```

### Required CORE-AUDIT Output

Every CORE-AUDIT must produce:

```
1. Real working modules
2. Shell / stub modules
3. Tests that exist but do not prove behavior
4. Capabilities not connected to product flow
5. First 10 critical implementation tasks
6. Claude Code task pack
7. Codex review gate checklist
```

### CORE-AUDIT Verdicts

Allowed verdicts:

```
PASS
PARTIAL
BLOCKED
FAKE_COMPLETE
NEEDS_RUNTIME_PROOF
NEEDS_TEST_EVIDENCE
NEEDS_PRODUCT_CONNECTION
```

- A `PASS` verdict requires repo-backed proof.
- A `PARTIAL` verdict must list gaps.
- A `FAKE_COMPLETE` verdict means the work looks done but lacks runtime/product/test evidence.

---

## P-02 — TASK-PACK Protocol

### Purpose

TASK-PACK converts audit findings into small implementation tasks.

Claude Code, OpenCode, Codex, or any implementation agent must not receive vague work.

**Bad task:**

```
Fix the verifier.
```

**Good task:**

```
Fix weak partial match downgrade in kernel.verify for medical contradiction cases.
Allowed files: kernel.js, test/semantic-verify.test.js.
Do not touch MCP, server, UI, package files, or docs.
Acceptance: weak partial match cannot return dogrulandi.
```

### Required TASK-PACK Fields

Every task pack must define:

```
Goal
Branch
Base commit
Allowed files
Forbidden files
Negative scope
Acceptance criteria
Targeted tests
Full test requirement
Expected diff
Stop conditions
Final report format
```

### Required Negative Scope

Every task must say what must not be touched.

Examples:

```
Do not touch package files.
Do not touch public/index.html.
Do not touch server.js.
Do not touch MCP tools.
Do not touch memory runtime.
Do not stage runtime artifacts.
Do not use git add .
Do not modify unrelated local drift.
```

Negative scope cannot be empty.

### Expected Diff

The task pack should estimate the expected diff.

Examples:

```
Expected diff:
- 1 runtime file
- 1 test file
- less than 120 changed lines
```

If actual diff is much wider than expected, the agent must stop and report scope drift.

### Stop Conditions

The agent must stop if:

```
test fails
base is wrong
dirty root contains unrelated changes
forbidden file needs modification
scope expands
runtime behavior differs from task
security boundary changes unexpectedly
approval is required
```

---

## P-03 — REVIEW-GATE Protocol

### Purpose

REVIEW-GATE prevents unverified code from entering the canonical branch.

**Review is not style commentary.**
**Review is a gate.**

### Required Review Checks

Codex or reviewer must check:

```
1. Diff scope
2. Test reality
3. Product claim truth
4. Security/runtime effect
5. Memory/provenance/gate impact
6. Forbidden claims
7. Merge readiness
```

### 1. Diff Scope

Check:

```
Did the PR change only allowed files?
Did it touch package files?
Did it touch runtime artifacts?
Did it include unrelated local drift?
Did it use broad stage?
Did it modify generated files?
```

A PR with unrelated drift is blocked.

### 2. Test Reality

Check:

```
Are tests real behavior assertions?
Are tests only snapshots?
Are tests only checking object shape?
Do tests cover failure paths?
Do tests cover fail-closed behavior?
Do tests prove the product claim?
```

A test count alone is not evidence.

### 3. Product Claim Truth

Check whether README, UI, docs, comments, or pitch language claim more than code proves.

**Forbidden example:**

```
HUQAN controls all agent execution.
```

**Allowed safer version:**

```
HUQAN includes tested action gate primitives and selected MCP fail-closed paths.
```

### 4. Security / Runtime Effect

Check:

```
Does this open a new public endpoint?
Does this weaken auth?
Does this allow mutation?
Does this bypass admission?
Does this skip provenance?
Does this break workspace isolation?
Does this change fail-closed to fail-open?
```

If uncertain, block.

### 5. Merge Readiness

A PR is merge-ready only if:

```
targeted tests pass
full required test suite passes or known unrelated failures are documented
diff scope is clean
forbidden files are absent
dirty root was not touched
reviewer verdict is PASS
```

Auto-merge is not allowed unless explicitly approved for that PR.

---

## P-04 — TÜBİTAK / Evidence Pack Protocol

### Purpose

Every closed work item must produce reusable evidence.

This evidence must support:

- internal engineering review
- investor updates
- TÜBİTAK / BİGG reporting
- release notes
- technical due diligence
- future audit

### Required Evidence Pack

Every closed work item must include:

```
PR
commit
branch
base HEAD
changed files
test result
CLI / screenshot / UI evidence
risk note
milestone mapping
what changed
what did not change
known gaps
final verdict
```

### Evidence Pack Template

```
WORK ITEM:
BRANCH:
BASE HEAD:
HEAD COMMIT:
PR:
CHANGED FILES:

SUMMARY:
TESTS:
EVIDENCE:
RISK:
MILESTONE:
KNOWN GAPS:
DIRTY ROOT:
ARTIFACTS:
VERDICT:
READY_FOR_REVIEW:
```

### Evidence Rules

Evidence must be specific.

**Bad:**

```
Tests passed.
```

**Good:**

```
npm test passed: 835 tests / 819 pass / 0 fail / 16 skipped.
Targeted: node --test test/tool-call-bypass-regression.test.js passed.
```

**Bad:**

```
UI works.
```

**Good:**

```
Product Console smoke:
- HUQAN'a sor input visible
- supported Turkish queries return repo-backed answers
- no demo wording
- no mojibake markers
```

---

## P-05 — Agent Coordination Protocol

### Purpose

Different agents must not step on each other.

Implementation, review, architecture, merge, and final approval are separate responsibilities.

### Claude / Implementation Agent Role

Claude or implementation agent owns:

```
implementation throughput
small scoped patches
targeted test writing
CLI output generation
file-level changes
bug-fix execution
```

Claude does not own:

```
merge decision
broad architecture changes without approval
release claim approval
security exception approval
roadmap rewriting
dirty root cleanup outside task
```

### Codex / Review Gate Role

Codex owns:

```
audit
architecture review
diff review
security review
test reality review
merge gate recommendation
critical fixes only when explicitly asked
```

Codex does not own:

```
unapproved implementation expansion
auto-merge
broad refactor outside task
rewriting product direction without checkpoint
```

### User / Final Approver Role

The user owns:

```
final merge approval
product direction approval
scope tradeoff approval
external claim approval
roadmap phase transition approval
```

---

## Global Hard Rules

These rules apply to every HUQAN work item.

```
Dirty root'a dokunma.
Broad stage yok.
git add . yok.
Runtime artifact stage/commit yok.
agent.memory.json stage/commit yok.
memory.json stage/commit yok.
memory.db stage/commit yok.
logs/temp/cache stage/commit yok.
Auto-merge yok.
Test fail olursa dur.
Scope genişlerse dur.
Base yanlışsa dur.
Forbidden claim varsa iş kapanmaz.
```

---

## Work Item Closure Checklist

A HUQAN work item cannot close unless all required items are true:

```
[ ] repo-backed evidence exists
[ ] test exists
[ ] product behavior is connected or explicitly out of scope
[ ] skeleton/stub/fake completeness removed or documented as known gap
[ ] forbidden claim does not exist
[ ] Trust/provenance/gate effect is explained
[ ] dirty root was not touched
[ ] PR scope remained narrow
[ ] targeted tests passed
[ ] full required tests passed or unrelated failures documented
[ ] final report includes branch, base HEAD, changed files, tests, artifacts, dirty root, verdict
```

---

## Forbidden Claim Policy

HUQAN must not claim:

```
guarantees truth
eliminates hallucinations
controls every agent path
full inline control plane
production-ready enterprise governance
all connectors are governed
all memory writes are structurally admission-gated
universal trust protocol
industry standard
legal/medical truth engine
```

Unless each claim is backed by repo evidence, tests, runtime proof, and external adoption where applicable.

**Safer language:**

```
partial trust layer
tested trust primitives
selected fail-closed paths
repo-backed verification
local-first trust boundary
evidence-backed Trust Receipt
known connector paths are admission-gated
MCP path is tested for selected tools
```

---

## Final Report Format

Every PR or work item must end with:

```
BRANCH:
BASE HEAD:
HEAD COMMIT:
CHANGED FILES:
TESTS:
ARTIFACTS:
DIRTY ROOT:
SCOPE:
TRUST / PROVENANCE / GATE IMPACT:
KNOWN GAPS:
VERDICT:
NEXT STEP:
READY_FOR_REVIEW:
```

Allowed verdicts:

```
PASS
READY_FOR_REVIEW
BLOCKED
NEEDS_FIX
DROP_DIFF
MERGE_READY
DO_NOT_MERGE
```

---

## Canonical Closing Line

**No HUQAN work item closes by claim.**
**It closes by evidence.**
