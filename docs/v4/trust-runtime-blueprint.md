# HUQAN / AXIOM — V4 Trust Runtime Blueprint

**Status:** V4-PR0 docs-only contract.
**Base at authoring:** `fab6e502f6490baedf8df5b9e08b47c2df3138bc` (`claude/practical-knuth-0ecsze`, post-#145).
**Depends on:** `docs/v4/v4-pr-plan.md`, `docs/v4/big-file-refactor-gate.md` (merged in #145).

---

## 1. Definition

> **HUQAN V4 = Deterministic Runtime Judgment for Intent-Driven Autonomous Agents.**

- **Trust Console** is the product surface — the thing a user/operator looks at.
- **Trust Runtime** is the execution boundary — the thing every agent action must pass through before it takes effect.
- **Workbench** is secondary to Trust Console. It is a development/inspection aid, not the primary product surface. Where the two conflict for priority, Trust Console wins.

---

## 2. Core flow

```
Intent
  → Agent
    → Action / Tool / Memory Proposal
      → Verdict
        → Approval (if required)
          → Trust Receipt
```

Every proposal (a canonical write, a tool call, a memory mutation) must produce a verdict before it can take effect, and a receipt after it resolves — allowed or not. Nothing skips the verdict step, and nothing that mutates state does so without leaving a receipt.

---

## 3. Allowed V4 surfaces

```
Trust Console
Trust Runtime
Action Verdict Core
MCP Tool Verdict Layer
Trust Receipt Ledger / Viewer
Memory Admission / Context Integrity Surface
Agent Identity / Ownership / Expiry input model
Connector Coverage Matrix
Demo packs, clearly labeled
```

Notes on scope for each:

- **Trust Console** — the primary UI/API surface exposing verdicts, receipts, and memory-admission state.
- **Trust Runtime** — the underlying deterministic judgment engine (built from the existing FAZ2 gates, reconciled per `docs/v4/verdict-reconciliation.md`).
- **Action Verdict Core** — the reconciled, canonical verdict contract (V4-PR2).
- **MCP Tool Verdict Layer** — pre-call verdicts for MCP tool invocations, tested-path first (V4-PR4).
- **Trust Receipt Ledger / Viewer** — a read surface over a hardened, tamper-evident receipt primitive (V4-PR2.5, then V4-PR3). The viewer cannot claim tamper-evidence before the primitive is hardened.
- **Memory Admission / Context Integrity Surface** — a read surface over admission decisions, provenance, and contradiction state (V4-PR5). Not a memory database.
- **Agent Identity / Ownership / Expiry input model** — identity, owner, delegation, scope, and expiry are treated as **verdict input**, not as a HUQAN-issued identity. HUQAN is not an identity provider.
- **Connector Coverage Matrix** — an explicit, honest table of which connector paths are tested/green versus untested/unlabeled. See `docs/v4/no-mock-contract-and-claim-boundaries.md`.
- **Demo packs** — vertical-specific demonstrations, each carrying a visible "demo" or "mock policy" label; never presented as a production guarantee.

---

## 4. V4 non-goals

```
Supabase wallet
public agent marketplace
real payment settlement
crypto/token system
full compliance platform
full endpoint security product
foundation model development
vector DB / memory database competition
full connector coverage claim
production-ready enterprise platform claim
```

These are not deferred features to build later inside V4 — they are explicitly out of scope for the V4 program as defined by this blueprint. Reconsidering any of them requires a new blueprint revision, not an incremental PR.

---

## 5. Preserved PR sequencing (from #145)

```
V4-PR0   — Trust Runtime / Console Blueprint            (this document)
V4-PR1   — No-Mock Contract + Claim Boundaries           (this PR)
V4-PR2   — Unified Verdict Reconciliation + Schema
V4-PR2.5 — Trust Receipt Primitive Hardening
V4-PR3   — Trust Receipt v1 Surface
V4-PR4   — MCP Tool Verdict Surface
V4-PR5   — Memory Admission / Context Integrity Surface
V4-PR6   — Demo Pack
```

This sequence, its dependency map, and the per-PR acceptance criteria are defined in `docs/v4/v4-pr-plan.md` and are not repeated or altered here. This blueprint constrains *what may exist* in V4; `v4-pr-plan.md` constrains *how it gets built*.

---

## 6. Relationship to prior positioning

The three report-grounded axioms from `docs/v4/v4-pr-plan.md` § 0 govern this blueprint and every surface listed above:

1. The market moved from a model-quality race to a race over agent identity, authority, memory, tool use, and pre-action review.
2. The heart of V4 is not monitoring — it is pre-action deterministic verdict.
3. Trust Receipt is not merely a log — it is a core product asset for incident reporting, audit export, and compliance evidence.

No surface in § 3 may be built or marketed in a way that contradicts these three sentences.
