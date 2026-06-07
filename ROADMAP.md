# HUQAN / AXIOM Roadmap

> **Models generate. Agents act. Memory stores. AXIOM judges.**

<details open>
<summary><strong>Current Sprint: AB1 — Action Risk Classifier</strong></summary>

**Date:** 2026-06-07 → 2026-06-14  
**Track:** V2 — Action Boundary / Tool Safety Layer  
**Goal:** Implement, test, and review `lib/action-risk-classifier.js`.

AB1 implements the first deterministic action-risk classifier.

It does **not** execute tools.  
It only classifies intended actions before any execution layer exists.

```txt
What kind of action is this?
How risky is it?
Should it be allowed, reviewed, or blocked?
```

<details>
<summary><strong>Goal</strong></summary>

Implement and test:

```txt
lib/action-risk-classifier.js
```

Core function:

```js
classify(action, opts = {})
```

Expected output shape:

```js
{
  ok: true,
  actionType,
  riskLevel,
  decision,
  reasons,
  requiredReview,
  blocked,
  policyVersion,
  meta
}
```

Allowed `riskLevel` values:

- `low`
- `medium`
- `high`
- `critical`

Allowed `decision` values:

- `allow`
- `review`
- `block`

</details>

<details>
<summary><strong>Forbidden in AB1</strong></summary>

- Tool execution
- Server/API/MCP changes
- Memory write
- Deploy
- Auto-merge
- External network calls
- UI changes
- Package version bump
- Self-healer logic
- GitHub PR automation

</details>

<details>
<summary><strong>To Do</strong></summary>

- Extract action classes from `docs/action-taxonomy.md`
- Implement `classify()` function
- Add 5 core tests
- Add edge-case tests:
  - `null`
  - `undefined`
  - empty object
  - unknown action type
- Open PR
- Request review

</details>

<details>
<summary><strong>Action Classes</strong></summary>

Minimum action classes:

| Class | Default Risk | Default Decision |
|---|---:|---:|
| `read_only` | low | allow |
| `local_analysis` | low | allow |
| `test_execution` | medium | allow / review |
| `file_write` | medium | review |
| `memory_write` | high | review / block |
| `tool_execution` | high | review |
| `network_access` | high | review |
| `deployment` | critical | block / human review |
| `destructive` | critical | block |
| `auto_merge` | critical | block |
| `unknown` | high | review / block |

</details>

<details>
<summary><strong>Required Tests</strong></summary>

Core tests:

- `read_only` action is low risk and allowed
- `file_write` action requires review
- `tool_execution` action requires review and does not execute
- `deployment` action is critical and blocked or requires human review
- `auto_merge` action is critical and blocked

Edge-case tests:

- `null` action does not throw
- `undefined` action does not throw
- empty object becomes unknown
- unknown action type is not silently allowed
- malformed fields normalize safely

</details>

<details>
<summary><strong>Definition of Done</strong></summary>

AB1 is complete only if:

- `lib/action-risk-classifier.js` exists
- `classify()` is exported
- tests exist
- null / undefined / unknown action cases are covered
- `npm test` passes
- only `lib/` and `test/` changed
- `docs/action-taxonomy.md` changed only if needed
- no server/API/MCP changes
- no tool execution behavior added
- no memory writes added
- no deploy logic added
- no auto-merge logic added
- PR opened
- review requested
- no auto-merge

</details>

<details>
<summary><strong>Next Sprint</strong></summary>

AB2 — Tool Call Gate

AB2 may consume AB1 `classify()` results.

AB2 must not be started inside AB1.

</details>

</details>

---

# V1 → V5 Roadmap

<details>
<summary><strong>V1 — Trust Kernel / Causal Granite</strong></summary>

**Purpose:** Build the deterministic trust and reasoning kernel.

Main question:

```txt
Is this claim safe to believe?
```

Core capabilities:

- graph-backed knowledge
- causal reasoning
- semantic trust gate
- provenance
- audit
- Trust Receipt
- ATP / `.axiom` package foundation
- reasoning trace
- claim decomposition
- local-first verification

Rule:

```txt
No weak, risky, contradictory, or provenance-less claim should become trusted canonical knowledge.
```

</details>

<details open>
<summary><strong>V2 — Action Boundary / Tool Safety Layer</strong></summary>

**Purpose:** Before agents act, classify and gate their actions.

Main question:

```txt
Is this action safe to perform?
```

Sprint sequence:

- AB0 — Action Boundary ADR / Architecture
- AB1 — Action Risk Classifier
- AB2 — Tool Call Gate
- AB3 — Action Receipt
- AB4 — Sandbox / Dry Run Boundary
- AB5 — Agent Workflow Admission

Rule:

```txt
No agent action should bypass classification.
```

</details>

<details>
<summary><strong>V3 — Governance / Workspace / Enterprise Control</strong></summary>

**Purpose:** Make HUQAN / AXIOM usable in teams and controlled environments.

Main question:

```txt
Who is allowed to trust, approve, reject, or execute this?
```

Capabilities:

- workspace policies
- role-aware review
- approval gates
- team audit trail
- policy packs
- project-level trust settings
- enterprise dashboard
- scheduled scans
- compliance exports

Rule:

```txt
Trust and execution must be governed by workspace policy, not hardcoded behavior.
```

</details>

<details>
<summary><strong>V4 — Self-Healer / Accountable AI Engineer</strong></summary>

**Purpose:** Let AXIOM detect bugs, propose fixes, write tests, and open draft PRs.

Main question:

```txt
What is broken, what fix is proposed, and should a human approve it?
```

Capabilities:

- repo scan memory
- bug pattern memory
- fix proposal
- regression test generation
- draft PR creation
- Trust Receipt for each proposed fix
- human review required

Hard rules:

- Draft PR only
- No auto-merge
- No silent production mutation
- No canonical fix fact without review
- Human decides

Rule:

```txt
AXIOM may propose repairs, but humans approve them.
```

</details>

<details>
<summary><strong>V5 — Ecosystem / Marketplace / Agent Exchange</strong></summary>

**Purpose:** Turn HUQAN / AXIOM into a trust infrastructure layer for external tools, agents, and teams.

Main question:

```txt
Can external agents, tools, and organizations exchange trusted work safely?
```

Capabilities:

- GitHub App
- Streaming Trust
- public Trust Receipts
- `.axiom` package exchange
- ATP / HTP compatibility
- conformance suite
- internal agent economy
- later public agent/service marketplace
- reputation based on verified delivery, not self-claims

Rule:

```txt
No marketplace before internal trust, escrow, receipt, reputation, and review gates are stable.
```

</details>

---

# GitHub Release Short Version

<details open>
<summary><strong>AB1 — Action Risk Classifier</strong></summary>

AB1 starts the V2 Action Boundary track.

It adds the first deterministic classifier for intended agent actions.

AB1 does not execute tools, write memory, deploy, or auto-merge.

It only classifies risk.

</details>

<details>
<summary><strong>Why It Matters</strong></summary>

V1 answered:

```txt
Is this claim safe to believe?
```

V2 starts answering:

```txt
Is this action safe to perform?
```

Before agents can execute tools, mutate files, write memory, open PRs, or deploy, AXIOM must classify the risk of the intended action.

</details>

<details>
<summary><strong>Safety Rules</strong></summary>

- No tool execution
- No server/API/MCP changes
- No memory write
- No deploy
- No auto-merge
- Unknown actions are not silently allowed
- Destructive actions are blocked

</details>

<details>
<summary><strong>Next</strong></summary>

AB2 — Tool Call Gate

AB2 consumes AB1 `classify()` results and begins enforcing tool-call boundaries.

</details>
