# AXIOM/HUQAN — MCP Private Alpha Readiness

**Date:** 2026-06-08
**Status:** Ready for private alpha
**Depends on:** V2.5 Agent Brake Layer (sealed)

---

## What Is MCP Private Alpha

MCP (Model Context Protocol) private alpha exposes AXIOM/HUQAN's safety gates to a small group of trusted testers. The goal is to validate that the brake layer works correctly in real-world MCP tool call scenarios without exposing unsafe surfaces.

Private alpha is **not** public beta. Access is invite-only. The surface area is minimal and fully gated.

---

## What Is Safe to Expose

| Component | Status | Notes |
|-----------|--------|-------|
| AB1 — Action Risk Classifier | ✅ Safe | Pure classifier, no side effects |
| AB2 — Tool Call Gate | ✅ Safe | Authorization only, never executes |
| AB3 — Code Change Gate | ✅ Safe | Verification only, no mutations |
| AB4 — Memory Mutation Gate | ✅ Safe | Approval only, never writes |
| AB5 — Automation Safety Gate | ✅ Safe | Review only, no automation |
| AB6 — Sandbox Isolation Gate | ✅ Safe | Classification only, no execution |
| Risk classification API | ✅ Safe | Stateless, deterministic |
| Decision summary API | ✅ Safe | Read-only aggregation |

---

## What Must Remain Disabled

| Component | Reason | Target |
|-----------|--------|--------|
| Dream/Hypothesis Engine | Not V2.5 scope, needs human review gate | Post-alpha |
| Auto-merge | Safety policy violation | Never unless repo policy |
| Direct memory writes from MCP | AB4 must gate all writes | V2.6 runtime integration |
| Tool execution from MCP | AB2 must gate all execution | V2.6 runtime integration |
| Sandbox execution from MCP | AB6 must gate all execution | V2.6 runtime integration |
| Recursive automation | Blocked by AB5 | Never |
| Unscoped permissions | Blocked by AB1+AB2 | Never |

---

## Required Config Placeholder

```json
{
  "axiom": {
    "version": "0.9.1",
    "brakeLayer": {
      "enabled": true,
      "policyVersion": "AB6-v0.1.0",
      "gates": ["AB1", "AB2", "AB3", "AB4", "AB5", "AB6"],
      "failSafe": "block",
      "unknownAction": "block",
      "unknownTool": "block",
      "unknownRunner": "block"
    },
    "mcp": {
      "alpha": true,
      "public": false,
      "allowedTools": ["classify", "summarize", "status"],
      "blockedTools": ["execute", "write", "deploy", "merge"],
      "sandboxMaxTimeoutMs": 1000,
      "requireSnapshot": true,
      "allowExternalNetwork": false,
      "allowUntestedSource": false
    }
  }
}
```

---

## Gate Chain — How It Works

```
External Action Requested
        │
        ▼
   ┌─────────────┐
   │   AB1       │  Classify risk tier
   │   Risk      │  (safe/elevated/critical)
   │   Classifier│
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │   AB2       │  Authorize tool call
   │   Tool Call │  (allow/deny/block)
   │   Gate      │
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │   AB3       │  Verify code changes
   │   Code      │  (approved/rejected/needs-review)
   │   Change    │
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │   AB4       │  Approve memory mutations
   │   Memory    │  (approved/blocked/quarantine)
   │   Mutation  │
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │   AB5       │  Review automation safety
   │   Automation│  (safe/unsafe/needs-review)
   │   Safety    │
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │   AB6       │  Evaluate sandbox isolation
   │   Sandbox   │  (allow/quarantine/rollback/block)
   │   Isolation │
   └──────┬──────┘
          │
          ▼
   EXECUTION ALLOWED
   (only if all gates pass)
```

**Key principle:** No gate executes runtime operations. All gates classify, authorize, verify, or advise. Execution happens downstream, only after all gates pass.

---

## Private Alpha Checklist

- [x] AB1 merged and sealed
- [x] AB2 merged and sealed
- [x] AB3 merged and sealed
- [x] AB4 merged and sealed
- [x] AB5 merged and sealed
- [x] AB6 merged and sealed
- [x] Full test suite passing (1163 pass / 0 fail)
- [x] No security gate violations
- [x] No auto-backdoor detected
- [x] No auto-collusion detected
- [x] All gates are pure-functional (no side effects)
- [x] All enums frozen
- [x] Fail-safe behavior confirmed (unknown → block)
- [x] Documentation complete
- [x] MCP server runtime integration (V2.6-PR0 inventory, PR1 adapter, PR2 enforcement)
- [x] Config validation for MCP tools (V2.6 adapter classifies all 10 tools)
- [x] Limited tool surface for alpha testers (8 allow, 1 review, 1 dry_run_only)
- [ ] Monitoring/logging for alpha usage (post-alpha)

---

## Public Beta Blockers

| Blocker | Priority | Notes |
|---------|----------|-------|
| MCP server runtime integration | High | Gates must be wired into MCP tool dispatch |
| Config validation | High | MCP config must be validated before any tool call |
| Limited tool surface | High | Only safe tools exposed to beta testers |
| Monitoring/logging | Medium | Alpha usage must be trackable |
| Rate limiting | Medium | Prevent abuse during beta |
| Error reporting | Medium | Beta testers need clear error messages |
| Documentation for beta testers | Medium | Setup guide, troubleshooting |
| Dream integration (optional) | Low | Could be post-beta |

---

## Show HN Blockers

| Blocker | Priority | Notes |
|---------|----------|-------|
| Public demo | High | Working demo that shows brake layer in action |
| README update | High | Clear explanation of what AXIOM/HUQAN does |
| One-liner install | High | `npm install` or similar |
| Demo video/GIF | Medium | Visual proof of concept |
| Blog post / writeup | Medium | Technical explanation for HN audience |
| GitHub stars / social proof | Low | Nice to have, not blocking |

---

## Recommended Demo Scenario

```
1. Show tool call without brake layer → unsafe action allowed
2. Enable AB1 → risk classification blocks critical action
3. Enable AB1+AB2 → unauthorized tool call blocked
4. Enable full chain → all six gates active
5. Attempt untrusted code execution → AB6 blocks (unknown runner)
6. Attempt memory mutation → AB4 blocks (unauthorized)
7. Show summary: "6 gates, 0 bypass, all safe"
```

---

## What Changed Since V2.4

| Area | V2.4 | V2.5 | V2.6 |
|------|------|------|------|
| Safety gates | 0 | 6 (AB1–AB6) | 6 + MCP gate adapter |
| Risk classification | None | AB1 classifies all actions | AB1 wired at MCP boundary |
| Tool call gating | None | AB2 authorizes all tool calls | AB2 wired at MCP boundary |
| Code change verification | None | AB3 verifies all code changes | — |
| Memory mutation approval | None | AB4 approves all memory writes | AB4 wired at MCP boundary |
| Automation safety review | None | AB5 reviews all automation | AB5 wired at MCP boundary |
| Sandbox isolation | None | AB6 evaluates all sandbox execution | AB6 wired at MCP boundary |
| MCP dispatch gating | None | None | **callTool() gate intercept** |
| Unknown tool handling | Crash | Crash | **Block with structured response** |
| Test coverage | Baseline | +181 gate-specific tests | +26 MCP gate tests |
| Fail-safe behavior | Undefined | Unknown → block everywhere | Unknown → block at MCP boundary |

---

## Verdict

```
MCP PRIVATE ALPHA — READY ✅

V2.5 Agent Brake Layer is sealed.
Safe surfaces identified.
Unsafe surfaces disabled.
Gate chain verified.
Documentation complete.

Next: MCP server runtime integration (V2.6)
```
