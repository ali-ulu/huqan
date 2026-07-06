# HUQAN MCP Write-Policy Audit

## What this document covers

This document records the raw evidence showing exactly how HUQAN's MCP server
handles **mutating operations** (writing new knowledge to persistent memory).

The audit was run to determine whether MCP persistence is:
- Intentionally blocked by gate/review policy, or
- Can be approved through an explicit approval path.

---

## Commit

```
fb68c27f16fd7ab302e95b28e4e7598441ae7cb0
```

## Repo

```
C:\Users\sonfi\Desktop\huqan\axiom-main-clean
```

## Run ID

```
run_1782646332189
```

---

## Exact Command

```
node demos/mcp_write_policy_audit.js
```

---

## Step-by-step findings

### Step 1 — tools/list

Raw file:

```
evidence/mcp-write-policy/run_1782646332189/01_tools_list.raw.json
```

`axiom.learn` is present in the tools list. Write tool confirmed available at MCP layer.

### Step 2 — axiom.learn called via MCP

Statement:

```
azami hiz asilmasi guvenlik ihlalidir
```

Raw file:

```
evidence/mcp-write-policy/run_1782646332189/02_axiom_learn.raw.json
```

Raw response (key fields):

```json
{
  "ok": false,
  "gate": {
    "decision": "review",
    "allowed": false,
    "canExecute": false,
    "canDryRun": true,
    "requiredReview": true,
    "reason": "mutating_requires_review",
    "metadata": {
      "policyVersion": "V2.6-PR1-v0.1.0"
    }
  },
  "approval": {
    "id": "approval-1782646332527-izxw67",
    "approvalKey": "mcp.axiom.learn",
    "tool": "axiom.learn",
    "status": "pending",
    "decision": "review"
  },
  "message": "Tool call queued for review: mutating_requires_review"
}
```

**Finding:** `axiom.learn` does not execute over MCP. It queues the request as `pending`
and returns `mutating_requires_review`. The DB is NOT modified.

### Step 3 — Approval tool search

Searched `tools/list` for: `approve`, `review`, `commit`, `accept`, `pending`, `queue`.

Matches found:

```
axiom.policy
axiom.approvals
```

### Step 4 — axiom.policy called

Raw file:

```
evidence/mcp-write-policy/run_1782646332189/03_approval.raw.json
```

Key response fields:

```json
{
  "action": "block",
  "approval": "blocked",
  "blocked": true,
  "requiresApproval": false,
  "reasons": [
    "External tool request: unknown.",
    "Unknown external tools are fail-closed by default."
  ],
  "executionMode": "blocked",
  "approvalStatus": "blocked"
}
```

**Finding:** `axiom.policy` is a policy evaluation tool, not a mutating approval tool.
Calling it with no known tool name returns `fail-closed` block.

`axiom.approvals` is a read-only approval queue listing tool. It does not provide
a commit/accept endpoint to approve pending writes.

**Conclusion:** There is no MCP-exposed path for an external agent to approve
its own mutating request. The approval path is intentionally not exposed over MCP.

### Step 5 — axiom.verify called

Statement:

```
azami hiz asilmasi guvenlik ihlali degildir
```

Raw file:

```
evidence/mcp-write-policy/run_1782646332189/04_verify.raw.json
```

Result:

```json
{
  "status": "celiski",
  "confidence": 0.9,
  "backend": "sqlite"
}
```

Verify works correctly. The contradiction was detected against rules that were
already in the DB from the previous PoC session (`run_1782645875208`).

---

## DB before/after

```
evidence/mcp-write-policy/run_1782646332189/00_db_before.json
evidence/mcp-write-policy/run_1782646332189/05_db_after.json
```

Node and edge counts are **unchanged** between before and after.
Confirmed: the blocked `axiom.learn` call made **no DB modification**.

---

## What this means

### What an MCP agent CAN do

| Operation | Available |
|---|---|
| Read/query knowledge graph | ✅ |
| Run `axiom.ask` | ✅ |
| Run `axiom.verify` | ✅ |
| Run `axiom.plan` | ✅ |
| Run `axiom.reason` | ✅ |
| Run `axiom.dream` | ✅ |
| Request a knowledge write (`axiom.learn`) | ✅ (queued) |

### What an MCP agent CANNOT do

| Operation | Blocked |
|---|---|
| Write directly to persistent memory | ✅ blocked |
| Self-approve its own mutating request | ✅ blocked |
| Bypass the review gate | ✅ blocked |
| Use `axiom.policy` to unblock itself | ✅ fail-closed |

### Security interpretation

```
Agent can request memory changes.
HUQAN does not blindly accept them.
Mutating memory requires out-of-band human review.
MCP approval path is fail-closed by design.
```

This is the correct architecture for safety-critical domains. No autonomous external
agent should be able to modify the system's persistent knowledge base without
an explicit human-in-the-loop gate.

---

## Correct product-level statement

> HUQAN's MCP interface supports read, verify, plan, and reason operations from
> external agents. When an agent requests a mutating operation such as `axiom.learn`,
> the system queues it under `mutating_requires_review` policy and does not execute it.
> The MCP layer exposes no approval path; an external agent cannot self-approve its
> own write requests. This is a deliberate fail-closed security design.

---

## What is NOT claimed

- MCP write persistence is not fully proven.
- There is no working MCP approval workflow for external agents.
- `axiom.approvals` and `axiom.policy` do not constitute a usable approval path
  for external MCP clients.

---

## Remaining risks

| Risk | Severity | Note |
|---|---|---|
| Approval queue grows unbounded if nobody reviews pending items | Medium | Needs a human review UI |
| `canDryRun: true` means dry-run reads the DB but does not modify it | Low | Expected behavior |
| Policy version `V2.6-PR1-v0.1.0` is hardcoded — version drift possible | Low | Should be pinned in config |

---

## Final Verdict

```
MCP_WRITE_REVIEW_REQUIRED
```

`axiom.learn` is reachable over MCP but is gated by `mutating_requires_review`.
No MCP-accessible approval path exists. Fail-closed behavior confirmed.

---

## Evidence files

| File | Description |
|---|---|
| `evidence/mcp-write-policy/run_1782646332189/00_db_before.json` | DB state before session |
| `evidence/mcp-write-policy/run_1782646332189/01_tools_list.raw.json` | Raw tools/list response |
| `evidence/mcp-write-policy/run_1782646332189/02_axiom_learn.raw.json` | Raw axiom.learn response |
| `evidence/mcp-write-policy/run_1782646332189/03_approval.raw.json` | Raw axiom.policy response |
| `evidence/mcp-write-policy/run_1782646332189/04_verify.raw.json` | Raw axiom.verify response |
| `evidence/mcp-write-policy/run_1782646332189/05_db_after.json` | DB state after session |
| `evidence/mcp-write-policy/run_1782646332189/transcript.ndjson` | Full JSON-RPC transcript |
| `evidence/mcp-write-policy/run_1782646332189/run_manifest.json` | Run manifest and verdict |
| `demos/mcp_write_policy_audit.js` | Audit client script |
