# HUQAN / AXIOM — Big File Refactor Gate

**Status:** planning gate (docs-only). This document decides *when* and *whether* large files may be split. It authorizes **no** refactor by itself.
**Base at authoring:** `af9b787abd8b50d0f08021307740fecf5928d271`.

---

## 1. Refactor timing rule

```
Large-file refactor may begin ONLY after V4-PR0/PR1 docs contract is merged.
A refactor must happen immediately BEFORE the runtime PR that depends on the file — not earlier "for cleanliness".
Every refactor must be mechanical and no-behavior-change.
```

Rationale: the V4 contract (PR0/PR1) decides which files actually need splitting. Splitting everything now, before the contract, risks behavior breakage with no V4 benefit. A file is refactored *just in time* for the PR that must edit it heavily — and only if that PR would otherwise be unsafe.

---

## 2. Candidate targets (measured at base `af9b787`)

Command used:

```bash
git ls-files "*.js" | grep -v node_modules | xargs wc -l | sort -nr | head -20
```

| Lines | File | Role | V4 relevance |
|---:|---|---|---|
| 3499 | `obsidian-plugin/dist/main.js` | **generated bundle** | none (build artifact) |
| 2398 | `kernel.js` | orchestrator monolith | high blast radius; no V4 PR owns it yet |
| 2252 | `lib/memory-store.js` | memory persistence | PR5 |
| 1389 | `graph.js` | graph storage | not V4-core |
| 1240 | `lib/automation-safety-gate.js` | AB5 gate | downstream of verdict |
| 1128 | `mcpServer.js` | MCP server + tool routing | PR4 |
| 1113 | `server.js` | REST | not V4-core |
| 1065 | `agent.js` | agent runtime | not V4-core |
| 1019 | `lib/memory-mutation-gate.js` | AB4 gate | downstream of verdict |
| 959 | `workflow-agent.js` | workflow runtime | not V4-core |
| 946 | `lib/verify.js` | verify service | not V4-core |
| 909 | `workflow-tools.js` | workflow tools | not V4-core |
| 891 | `lib/code-change-gate.js` | code gate | downstream of verdict |
| 884 | `lib/action-risk-classifier.js` | AB1 classifier | downstream of verdict |
| 838 | `kernel.v2.js` | v2 kernel | not V4-core |
| 799 | `lib/sandbox-isolation.js` | AB6 gate | downstream of verdict |
| 740 | `cli.js` | CLI | not V4-core |

**Verdict/receipt surface files that PR2/PR2.5 actually edit are small and clean:**

| Lines | File | Owned by |
|---:|---|---|
| 300 | `lib/mcp-gate-adapter.js` | PR2 (reconciliation) |
| 448 | `lib/memory-admission-gate.js` | PR2 + PR2.5 (receipt builder) |
| 131 | `lib/audit-log.js` | PR2.5 |
| 606 | `lib/tool-call-gate.js` | PR2 (adapter input) |

---

## 3. Classification

| File | Classification | Reason |
|---|---|---|
| `obsidian-plugin/dist/main.js` | **LEAVE_AS_IS** | Generated bundle — never hand-split a build artifact. |
| `kernel.js` (2398) | **NEEDS_MANUAL_REVIEW** | Orchestrator; huge blast radius. No V4 PR forces heavy edits. Do not split speculatively. |
| `lib/memory-store.js` (2252) | **REFACTOR_BEFORE_PR5** *(conditional)* | Only if PR5 requires heavy edits. If PR5 is read-surface only, LEAVE_AS_IS. |
| `mcpServer.js` (1128) | **REFACTOR_BEFORE_PR4** *(conditional)* | Only if PR4 requires heavy tool-routing edits. If PR4 adds a thin verdict hook, LEAVE_AS_IS. |
| `lib/memory-mutation-gate.js` (1019) | **LEAVE_AS_IS** | PR2 wraps its output via an adapter; it is not rewritten. |
| `lib/automation-safety-gate.js` (1240) | **LEAVE_AS_IS** | Downstream gate; PR2 reads its decision, does not restructure it. |
| `lib/action-risk-classifier.js` (884) | **LEAVE_AS_IS** | Same — adapter-wrapped, not rewritten. |
| `graph.js`, `server.js`, `agent.js`, `verify.js`, `workflow-*`, `kernel.v2.js`, `sandbox-isolation.js`, `code-change-gate.js`, `cli.js` | **LEAVE_AS_IS** | Not owned by any current V4 PR. |

**No file is classified `REFACTOR_BEFORE_PR2` or `REFACTOR_BEFORE_PR2_5`** — the verdict/receipt files PR2/PR2.5 touch (`mcp-gate-adapter.js` 300, `memory-admission-gate.js` 448, `audit-log.js` 131) are already small and clean.

---

## 4. Refactor rules (binding for any future REFACTOR-* PR)

```
✅ No behavior change.
✅ Tests identical before and after (same pass/fail set).
✅ Public API unchanged.
✅ Golden/snapshot behavior preserved.
✅ Small, targeted file split only.
✅ Targeted tests + full npm test pass.

❌ No new verdict behavior.
❌ No new receipt chain.
❌ No new UI.
❌ No new MCP behavior.
❌ No package / version change.
❌ No schema behavior change unless the runtime PR explicitly owns it.
❌ No broad refactor.
❌ No git add .
```

A REFACTOR-* PR is **not** a feature PR. If a split forces a behavior decision, stop — that decision belongs to the runtime PR, not the refactor.

---

## 5. Final recommendation

- **Before PR2 (verdict reconciliation):** no refactor needed. Files are small/clean; PR2 adds adapters + a schema.
- **Before PR2.5 (receipt primitive):** no refactor needed. Receipt builder (`memory-admission-gate.js` 448) and `audit-log.js` (131) are small; a new `lib/receipt/*` module can be *added* without splitting an existing giant.
- **Before PR4 (MCP surface):** re-audit `mcpServer.js` (1128) **at that time**. Split only if the PR needs heavy tool-routing edits.
- **Before PR5 (memory surface):** re-audit `lib/memory-store.js` (2252) **at that time**. Split only if the PR needs heavy edits; a read-surface PR likely does not.
- **`kernel.js` (2398):** do not touch speculatively. Revisit only if a specific runtime PR proves it unsafe to edit in place — then a dedicated `NEEDS_MANUAL_REVIEW` refactor PR, scoped and mechanical.

Re-run the measurement command at the start of PR4 and PR5; classifications above are valid only against base `af9b787` and must be re-checked if those files grow.

---

## VERDICT

```
VERDICT: V4_PLAN_READY_REFACTOR_NOT_STARTED
```

No large-file refactor is required before V4-PR2 or V4-PR2.5. Refactor decisions for `mcpServer.js` and `lib/memory-store.js` are deferred to just-in-time audits at PR4 and PR5 respectively, and only if those PRs require heavy edits. `kernel.js` remains untouched pending a specific, justified runtime need.
