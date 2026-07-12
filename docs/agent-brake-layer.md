# Agent Brake Layer

> Status: planning / spec only. No runtime implementation in this PR.
> Companion document: `docs/action-taxonomy.md`.

## 1. Purpose

Agentic AI systems can:

- call tools
- write to memory
- change code
- weaken or delete tests
- deploy
- request broader permissions
- execute multi-step tool chains

Before any of these actions execute, HUQAN / AXIOM must decide whether the action is safe, allowed, or forbidden. This document defines that decision layer.

The product principle is restated explicitly:

> **Models generate. Agents act. Memory stores. HUQAN / AXIOM judges.**

Judging agent actions is the natural next step after judging claims.

## 2. Scope

**In scope:**

- Runtime governance of agent actions: classify, score, and route each proposed action to a decision before it executes.

**Out of scope (this is NOT):**

- PR review — see `docs/SECURITY-GATE.md`.
- Content / claim verification — see `lib/risk-rules.js`.
- Memory Core admission — see PR-M1..M7.
- A new HTTP API, CLI command, MCP tool, plugin, or UI surface.
- Runtime implementation — this PR is spec-only.

## 3. Decision Classes

| Class         | Definition                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ALLOW`       | Low-risk action may proceed.                                                                                                   |
| `BLOCK`       | Action is forbidden.                                                                                                           |
| `QUARANTINE`  | Action may be staged in isolated / sandboxed form only. No production memory, canonical graph, deployment, or privileged state mutation. |
| `HUMAN_REVIEW`| Action must wait for explicit human approval.                                                                                 |

These four classes are mutually exclusive. Every classified action returns exactly one.

## 4. Risk Levels

| Level      | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `LOW`      | Side effects are local, reversible, and non-privileged.                            |
| `MEDIUM`   | Side effects may touch memory or filesystem but are not production-critical.       |
| `HIGH`     | Side effects may touch code, tests, canonical graph, or memory write.              |
| `CRITICAL` | Side effects may touch production, deployment, or security policy.                 |

Risk level is a property of the action category (see `docs/action-taxonomy.md` §1). The decision class is then derived from the risk level plus context.

## 5. Hard Rules

The following rules are absolute. No AB-series PR may weaken or bypass them.

- **Auto-merge is blocked.** No agent may merge a PR on its own.
- **Auto-deploy is blocked.** No agent may deploy on its own.
- **No permission self-escalation.** An agent cannot widen its own scope or grant itself new capabilities.
- **No weakening or deletion of security tests** without `HUMAN_REVIEW`. Tests that guard trust policy, risk rules, security gate, or sandbox boundaries are protected.
- **No direct production memory write.** Production memory writes go through Memory Core admission (workspace isolation, provenance, schema validation).
- **No canonical graph mutation without admission gate.** Canonical graph writes require provenance + admission.
- **Sandbox must not write to a real DB.** Sandbox simulations stay in isolated state.
- **Security policy changes require `HUMAN_REVIEW`** (and may default to `BLOCK`).
- **Tool-chain execution must be gated before execution.** No silent multi-step tool chains. Each step in a chain is re-evaluated.
- **High-risk actions require a Trust Receipt.** Every `BLOCK`, `QUARANTINE`, or `HUMAN_REVIEW` decision must produce a receipt (action, category, risk, decision, reason, timestamp).

## 6. Relationship to Existing Primitives

| Existing primitive                                  | What it does                                                                                                                                                                                              | Relationship to AB0                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `toolPolicy.js`                                     | Tool call gate with `action: 'allow' | 'block' | 'review'`, `riskScore 0-100`, `category: 'internal' | 'external'`, sandbox config (`node:vm`, `codeGeneration: 'disabled'`), `EXTERNAL_BLOCK_PATTERNS`, `INJECTION_PATTERNS`. | Closest existing primitive. AB0 is the spec; **PR-AB2** (Tool Call Gate) will align `toolPolicy.js` decision names to AB0.       |
| `lib/risk-rules.js`                                 | Claim / content risk with 11 rules (WEAK_PARTIAL_MATCH, HIGH_RISK_DOMAIN, ABSOLUTE_CLAIM, SCOPE_EXPANSION, RELATION_DRIFT, MULTILINGUAL_AMBIGUITY, PROVENANCE_MISSING, DOUBLE_NEGATION, WEASEL_WORDS, STRAWMAN_ATTRIBUTION, ALIAS_NORMALIZATION). Returns severity (0-1) + confidence (0-1). | Claim risk ≠ action risk. AB0 governs **actions**, not claims. Both layers compose: a claim can be risky, an action can be risky, and both gates must pass. |
| `docs/SECURITY-GATE.md`                             | PR / release gate with 6 categories (Public Endpoint Exposure, Auth, Filesystem & Process Safety, Trust Boundary, Test Coverage, Merge Decision).                                                       | PR gate, not runtime agent gate. AB0 is the **runtime companion**. PR-S* checks happen at merge time; AB0 checks happen at action time. |
| `docs/vision-next.md`                               | Product principles: "AXIOM judges, human decides. Auto-PR may open draft PRs only. Auto-merge is disabled. Models generate. Agents act. Memory stores. AXIOM judges."                                   | Source of truth for AB0's stance: agents act **under brake**, AXIOM judges, humans decide.                                   |
| Memory Core (PR-M1..M7)                             | Memory admission with provenance, workspace isolation, tombstone cascade, schema versioning, package roundtrip.                                                                                          | **PR-AB4** (Memory Mutation Gate) will reference Memory Core's admission rules.                                                |

**AB0 does not change any of these yet.** This PR is spec-only.

## 7. Future PR Roadmap

The Agent Brake Layer is delivered incrementally. Each future PR is gated by `docs/SECURITY-GATE.md` and must add tests.

- **PR-AB1** — Action Risk Classifier (deterministic mapping from action → risk level + decision).
- **PR-AB2** — Tool Call Gate (align `toolPolicy.js` decision names and risk score mapping to AB0).
- **PR-AB3** — Code Change Gate (block agent-initiated code mutations without `HUMAN_REVIEW`).
- **PR-AB4** — Memory Mutation Gate (block direct production memory writes; route through Memory Core admission).
- **PR-AB5** — No Auto-Merge / No Auto-Deploy Enforcement (server / policy-level guard).
- **PR-AB6** — Sandbox / Rollback Isolation policy (deterministic classification and rollback semantics; not a sandbox executor).

Each PR in this roadmap ships its own tests and its own SECURITY-GATE pass.
