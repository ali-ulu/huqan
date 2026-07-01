# HUQAN / AXIOM — Verdict Reconciliation (V4-PR2 Prework)

**Status:** V4-PR1 docs-only prework for V4-PR2. Does not implement a schema or runtime code.
**Base at authoring:** `fab6e502f6490baedf8df5b9e08b47c2df3138bc` (`claude/practical-knuth-0ecsze`, post-#145).

---

## 1. The problem

The runtime currently speaks **two different verdict vocabularies**, and the V4 report/blueprint implies a third:

```
Admission gate (lib/memory-admission-gate.js):
  allow · review · reject · quarantine

MCP gate (lib/mcp-gate-adapter.js):
  allow · review · block · dry_run_only · disabled

Report / V4 target vocabulary:
  allow · review · block · dry_run_only · require_approval
```

**`require_approval` exists in 0 lines of runtime code** (verified by grep across `lib/`, `kernel.js`, `plugin.js` at base `fab6e50`). Writing a "unified schema" without first reconciling the two real vocabularies above would create a **fourth** vocabulary layered on top of the existing two — the opposite of unification.

> **Do not create a fourth vocabulary.**

---

## 2. Mapping table

Verified against the actual decision semantics in code (`normalizedDecision.allowed = decision === 'allow'`, `canApply = decision === 'allow'` in the admission gate; `priority = { block: 4, dry_run_only: 3, review: 2, disabled: 1, allow: 0 }` in the MCP gate).

| Source layer | Current value | Canonical product verdict | Notes |
|---|---|---|---|
| admission | `allow` | `allow` | canonical write/action allowed |
| admission | `review` | `review` | approval/review semantics |
| admission | `reject` | `block` | rejected admission must not surface as allow — `graphWrite`/`allowed` is already `false`, matching `block` semantics |
| admission | `quarantine` | `quarantine` | memory/claim-specific non-executable state; distinct from `block` because it implies a holding state, not an outright rejection |
| MCP | `allow` | `allow` | tool call allowed |
| MCP | `review` | `review` | pending approval semantics |
| MCP | `block` | `block` | fail-closed |
| MCP | `dry_run_only` | `dry_run_only` | non-mutating safe path |
| MCP | `disabled` | `disabled` | configuration/policy unavailable — not a risk decision, a capability-availability state |

Every existing runtime decision maps to exactly one canonical verdict. No existing decision is dropped or renamed away from its current meaning — this table is a projection, not a behavior change.

---

## 3. Open decision: does `require_approval` become a distinct verdict?

**Option A** — `review` remains the runtime verdict; `require_approval` is UI copy / classification layered on top of `review` (e.g., "this review requires human approval before it can proceed" is a *rendering* of a `review` verdict, not a new state).

**Option B** — `require_approval` becomes a distinct runtime verdict, sitting alongside (or replacing) `review`.

### Recommendation

> **Prefer Option A unless a runtime PR proves that `require_approval` must be distinct.**

**Reason:** the existing runtime already emits `review` consistently across both gates, with working tests and audit-event wiring behind it (FAZ2-2, FAZ2-3, FAZ2-5). Introducing `require_approval` as a new runtime state prematurely — before any concrete case demonstrates that `review` cannot carry the required semantics — risks producing exactly the fourth vocabulary this document exists to prevent. If V4-PR2 (or a later PR) discovers a real case where `review` and `require_approval` must diverge in behavior (not just wording), that PR must document the specific behavioral gap before introducing a new verdict value.

---

## 4. Validation

**Docs-only. Runtime tests are not required for this document.**

This mapping table is prework: V4-PR2 is the PR that will implement the reconciliation (adapters + schema) and is required to add a test asserting that every legacy decision value (`reject`, `quarantine`, `dry_run_only`, `disabled`) resolves deterministically to a canonical verdict per the table above, with no existing gate test's behavior changed in the process.
