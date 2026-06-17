# Relation Extraction Final Checkpoint

**Date:** 2026-06-17
**Branch:** audit/relation-extraction-final-checkpoint
**Base commit:** e68c0fc8050d07b448126346a2361fab5efc4a6b
**Status:** CHECKPOINTED ✅

---

## Scope

This is a checkpoint document only. No runtime code was changed in this PR.

The purpose is to record and seal the final verified state of the relation extraction
recovery line after PR-REL-1 and PR #85 (PR-REL-1.1).

---

## Merged PRs

| PR | Title | Status |
|---|---|---|
| PR-REL-1 | Explicit CAUSES / PREVENTS / DEPENDS_ON / ENABLES marker extraction | ✅ merged into main |
| PR #85 (PR-REL-1.1) | Turkish DEPENDS_ON refinement — bagli/baglidir/bağlı/bağlıdır/baglıdır | ✅ merged — `e68c0fc` |
| PR #84 | Turkish DEPENDS_ON (first attempt) | ❌ superseded / do-not-merge — encoding regression source |

---

## Confirmed Behaviors

### CAUSES

| Input | Subject | Relation | Object |
|---|---|---|---|
| `Sigara kansere neden olur` | sigara | CAUSES | kanser |
| `Smoking causes cancer` | smoking | CAUSES | cancer |

### PREVENTS

| Input | Subject | Relation | Object |
|---|---|---|---|
| `Asilama hastaligi onler` | asilama | PREVENTS | hastalik |
| `Vaccination prevents disease` | vaccination | PREVENTS | disease |

### DEPENDS_ON

| Input | Subject | Relation | Object |
|---|---|---|---|
| `Deployment requires passing tests` | deployment | DEPENDS_ON | passing tests |
| `Build depends on dependencies` | build | DEPENDS_ON | dependencies |
| `Deployment testlerin gecmesine baglidir` | deployment | DEPENDS_ON | testlerin gecmesi |
| `Sistem veritabanina baglidir` | sistem | DEPENDS_ON | veritabanin |

### ENABLES

| Input | Subject | Relation | Object |
|---|---|---|---|
| `Authentication enables secure access` | authentication | ENABLES | secure access |
| `API anahtari erisimi mumkun kilar` | api anahtari | ENABLES | erisim |

### Turkish DEPENDS_ON Variants

All of the following surface forms correctly extract `DEPENDS_ON`:

| Surface form | Notes |
|---|---|
| `bagli` | ASCII, no diacritics |
| `baglidir` | ASCII, no diacritics |
| `bağlı` | Unicode ğ (U+011F) + ı (U+0131) |
| `bağlıdır` | Full Unicode form |
| `baglıdır` | Mixed: ASCII g, Unicode ı (U+0131) — common keyboard variant |

---

## Neutral Controls

The following sentences must **not** produce CAUSES / PREVENTS / DEPENDS_ON / ENABLES.
They are `tür` or `özellik` relations — confirmed safe:

| Input | Expected | Confirmed |
|---|---|---|
| `Aspirin beyaz tablettir` | neutral (tür/özellik) | ✅ |
| `B737 bir ucaktir` | neutral (tür) | ✅ |
| `React Native bir frameworktur` | neutral (tür) | ✅ |
| `Aspirin beyaz bir tablettir` | neutral (tür/özellik) | ✅ |

---

## Regression Coverage

Test commands run against `e68c0fc` (final main HEAD):

```bash
node --test test/relation-extraction-failure-audit.test.js
node --test test/canonical-determinism.test.js
node --test test/semantic-parser-negation.test.js
node --test test/real-user-smoke-blockers.test.js
node --test plugins/repo-memory.test.js
npm test
```

| Test suite | Result |
|---|---|
| relation-extraction-failure-audit | 1 pass / 0 fail |
| canonical-determinism | 1 pass / 0 fail |
| semantic-parser-negation | 5 pass / 0 fail |
| real-user-smoke-blockers | 5 pass / 0 fail |
| repo-memory | 2 pass / 0 fail |
| **npm test (full suite)** | **1500 pass / 0 fail / 16 skipped** |

Additional checks:

| Check | Result |
|---|---|
| `git diff --check` | clean |
| Mojibake scan (diff lines only) | clean — no mojibake in PR-introduced lines |
| Placeholder scan | clean |
| Working tree | clean |

---

## Known Remaining Limits

The following are intentional scope boundaries, not bugs:

- This is **explicit marker extraction**, not a full NLP engine. Detection relies on
  known Turkish and English surface markers only. Sentences without those markers fall
  through to `yapabilir` or `özellik` relations.

- The **generic `yapabilir` catch-all was not narrowed** in this line. Narrowing
  verb-suffix catch-all was explicitly out of scope to avoid regression risk.

- **Domain-specific relation extraction** (e.g., medical, legal, financial causal
  language) remains plugin/adapter territory and was not addressed here.

- **Verifier status contract was not changed.** Relation extraction improvements are
  upstream of verification; the verifier behavior, output shape, and contract version
  are unchanged.

- **Pre-existing mojibake in Turkish comments** (`kernel.js` lines outside the
  PR-REL-1 / PR #85 diff) were not modified. They are cosmetic comment encoding
  artifacts that do not affect runtime behavior. Fixing them is a separate cleanup task.

---

## Final Verdict

The relation extraction explicit marker line (PR-REL-1 + PR-REL-1.1) is
**checkpointed and safe to move on.**

Next steps in queue:
1. PR-FIX-CROSS-PLATFORM — Self-Healer audit runner Linux/macOS path fix
2. PR-S1 — SHD-1 + MEM-2
3. README / public positioning
