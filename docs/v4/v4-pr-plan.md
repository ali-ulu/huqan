# HUQAN / AXIOM — V4 PR Plan

**Status:** planning gate (docs-only). No runtime code is authorized by this document.
**Base at authoring:** `af9b787abd8b50d0f08021307740fecf5928d271` (`claude/practical-knuth-0ecsze`, post-FAZ2-7).
**Operating rule:** the blueprint may be large; every implementation PR must be small, narrow, sequenced, and evidence-backed (see `docs/HUQAN_WORK_PROTOCOL.md`).

---

## 0. V4 constitution (three report-grounded axioms)

These three sentences govern every V4 decision. When a scope question arises, resolve it against these, not against opinion.

1. The AI market moved from a *model-quality* race to a race over **agent identity, authority, memory, tool use, payment, delegation, and pre-action review**.
2. The heart of V4 is **not monitoring — it is pre-action deterministic verdict**.
3. **Trust Receipt is not merely a log** — it is a core product asset for incident reporting, audit export, and compliance evidence.

Single-sentence positioning:

> Models generate. Agents act. Memory stores. **HUQAN judges. Receipts prove.**

---

## 1. Starting-state facts (verified against code, not assumed)

These facts are why the report's suggested sequence is **revised** below. Each is grep-verified at base `af9b787`.

| Fact | Evidence | Consequence for the plan |
|---|---|---|
| Verdict vocabulary is **fragmented across three subsystems** | admission gate → `allow/review/reject/quarantine` (`lib/memory-admission-gate.js`); MCP gate → `allow/review/block/dry_run_only/disabled` (`lib/mcp-gate-adapter.js`); report/blueprint wants `require_approval` | **PR2 is reconciliation, not a fresh schema.** Writing a new schema without reconciling creates a *fourth* vocabulary. |
| `require_approval` exists in **0 lines** of runtime code | grep across `lib/`, `kernel.js`, `plugin.js` | PR2 must explicitly decide how `require_approval` maps in / relates to existing decisions before any surface uses it. |
| Trust Receipt is **content-addressed but not hash-chained** | `receiptId` = sha1 of decision content in `lib/memory-admission-gate.js`; **no** `previous_receipt_hash`; "chain" hits are all `causalChain`/`LangChain` | The current receipt cannot back a "tamper-evident ledger / prove-it-later" claim. **PR2.5 must harden the primitive before any viewer claims it.** |
| **No receipt/audit export path** exists | grep `export.*receipt` / `auditExport` → 0 | "audit export / compliance evidence" (axiom 3) is not yet real; PR2.5 owns it. |
| MCP coverage is **tested local stdio path only** | FAZ2-5 tests cover local shared-state + approval persistence; no arbitrary connector coverage | PR4 must label coverage honestly; no "all connectors" claim. |

---

## 2. Revised V4 PR sequence

Report order was: positioning → verdict schema → Trust Receipt v1 → MCP Tool Verdict → Memory Admission → Ownership/Expiry → demos.
**Revision (from the code facts above):** PR2 becomes *reconciliation*, and a new **PR2.5** hardens the receipt primitive *before* any receipt surface.

```
V4-PR0   — Trust Runtime / Console Blueprint           (docs)
V4-PR1   — No-Mock Contract + Claim Boundaries         (docs/spec)
V4-PR2   — Unified Verdict Reconciliation + Schema      (runtime + schema)
V4-PR2.5 — Trust Receipt Primitive Hardening            (runtime)
V4-PR3   — Trust Receipt v1 Surface                     (surface over the hardened primitive)
V4-PR4   — MCP Tool Verdict Surface                     (tested stdio first; rest coverage-labeled)
V4-PR5   — Memory Admission / Context Integrity Surface (surface)
V4-PR6   — Demo Pack                                    (labeled demos)
```

Dependency map:

```
PR0 ─┐
PR1 ─┴─> PR2 ──> PR2.5 ──> PR3 ──> PR6
                    │        │
                    └──> PR4 ┤
                    └──> PR5 ┘
```

PR2 (unified verdict) is the keystone: PR3/PR4/PR5 all consume the reconciled verdict contract. PR2.5 (receipt primitive) is a hard prerequisite of PR3 (viewer).

---

## 3. Per-PR specification

### V4-PR0 — Trust Runtime / Console Blueprint
- **Purpose:** lock the V4 positioning (runtime judgment, action boundary, receipt, memory governance, A2A handshake) as an ADR.
- **Allowed scope:** `docs/v4/*.md` only.
- **Negative scope:** no runtime code, no schema files, no tests, no package/version.
- **Likely files:** `docs/v4/runtime-judgment-architecture.md`, `docs/v4/intent-driven-agent-governance.md`, `docs/v4/non-goals.md`.
- **Acceptance:** ADR merged; positioning + non-goals unambiguous; capability map (FAZ2 primitive → V4 surface) present.
- **Proof:** docs review only.
- **Blockers:** none technical.
- **Forbidden claims:** "production-ready", "full trust control plane", "guarantees truth".

### V4-PR1 — No-Mock Contract + Claim Boundaries
- **Purpose:** write the enforceable boundary that keeps every later surface honest.
- **Allowed scope:** `docs/v4/no-mock-contract.md`, `docs/v4/claim-boundaries.md`.
- **Negative scope:** no runtime code, no UI.
- **Acceptance:** documents (a) what may be claimed today, (b) the three-vocabulary verdict gap, (c) the receipt-primitive gap (no hash chain, no export), (d) MCP coverage = tested local stdio path only.
- **Proof:** each boundary cites a code fact (file/line or grep result), not an opinion.
- **Blockers:** none.
- **Forbidden claims:** any claim not backed by a current test or code path.

### V4-PR2 — Unified Verdict Reconciliation + Schema
- **Purpose:** collapse the three verdict vocabularies into ONE canonical Action Verdict contract; publish the schema.
- **Allowed scope:** a single reconciliation module (e.g. `lib/verdict/*`) + `schemas/verdict/*.schema.json` + targeted tests. Adapters that map existing gate outputs → canonical verdict.
- **Negative scope:** no new *behavior* (a review stays a review; a reject stays a reject) — only unification of vocabulary; no receipt chain; no UI; no MCP behavior change.
- **Likely files:** new `lib/verdict/action-verdict.js`, `schemas/verdict/action-verdict.schema.json`; thin adapters referencing `lib/memory-admission-gate.js`, `lib/mcp-gate-adapter.js`.
- **Acceptance:**
  - one canonical decision set is defined (candidate: `allow / review / require_approval / block`), with an **explicit mapping table** from each existing decision (`reject`, `quarantine`, `dry_run_only`, `disabled`) into it;
  - existing gate tests remain green (no behavior drift);
  - no fourth vocabulary is introduced — every existing decision maps deterministically.
- **Proof:** `node --test` targeted verdict tests + full `npm test` green; a mapping-table test asserts every legacy decision resolves.
- **Blockers:** if reconciliation cannot be done without changing a gate's *behavior*, stop and escalate — that is a runtime decision, not a mapping.
- **Forbidden claims:** none about receipts/tamper-evidence yet.

### V4-PR2.5 — Trust Receipt Primitive Hardening
- **Purpose:** make the receipt actually able to "prove it later" — before any viewer claims it.
- **Allowed scope:** receipt builder + audit log + an export function + targeted tests.
- **Negative scope:** no viewer/UI; no verdict behavior change; no MCP change.
- **Likely files:** `lib/memory-admission-gate.js` (receipt builder), `lib/audit-log.js`, new `lib/receipt/*` if a split is warranted (subject to the refactor gate).
- **Acceptance:**
  - receipts carry `previous_receipt_hash` (tamper-evident chain) OR an explicitly documented equivalent;
  - an export path emits a verifiable receipt bundle (for incident reporting / audit);
  - chain integrity is verifiable by a test that detects a tampered link.
- **Proof:** targeted receipt-chain + export tests; full `npm test` green.
- **Blockers:** if hardening requires touching a >1000-line file destructively, route through the refactor gate first.
- **Forbidden claims:** "immutable ledger" unless the chain-integrity test proves tamper-evidence.

### V4-PR3 — Trust Receipt v1 Surface
- **Purpose:** expose the hardened receipt (id, actor, agent, tool, action, verdict, risk, evidence, provenance, policy, timestamp, previous/next receipt).
- **Allowed scope:** a read surface (API/CLI/view) over real receipts.
- **Negative scope:** no mock data — every field must come from a real receipt produced by PR2/PR2.5.
- **Acceptance:** surface renders only fields that exist on real receipts; no placeholder/fake rows.
- **Proof:** a test loads a real receipt through the pipeline and asserts the surface reflects it.
- **Blockers:** if any displayed field has no real backing, stop (no-mock contract violation).
- **Forbidden claims:** compliance-export guarantees beyond what PR2.5 actually implemented.

### V4-PR4 — MCP Tool Verdict Surface
- **Purpose:** surface pre-call verdicts for MCP tool calls (deny-by-default, side-effect class, receipt per high-risk call) on the tested path.
- **Allowed scope:** verdict surfacing for the tested local stdio MCP path; coverage labels for others.
- **Negative scope:** no "all connectors covered" claim; no new MCP persistence.
- **Likely files:** `mcpServer.js` (1128 lines — see refactor gate before heavy edits), `lib/mcp-gate-adapter.js`.
- **Acceptance:** tested stdio path shows verdict + receipt; untested connectors are explicitly labeled uncovered.
- **Proof:** MCP dogfood tests remain green; coverage labels asserted.
- **Blockers:** heavy `mcpServer.js` edits → refactor gate first.
- **Forbidden claims:** "every connector path passes an inline gate."

### V4-PR5 — Memory Admission / Context Integrity Surface
- **Purpose:** surface canonical / candidate / tombstoned memories, contradictions, provenance, and the memory→action risk gate.
- **Allowed scope:** read surface over the existing admission gate + memory store.
- **Negative scope:** we are not a memory database; no new storage engine; no vector-DB competition.
- **Likely files:** `lib/memory-store.js` (2252 lines — refactor gate before heavy edits), `lib/memory-admission-gate.js`.
- **Acceptance:** surface reflects real admission outcomes and provenance; low-confidence / missing-provenance states are visible.
- **Proof:** tests over real memory-admission outcomes; full `npm test` green.
- **Blockers:** heavy `memory-store.js` edits → refactor gate first.
- **Forbidden claims:** "prevents all memory poisoning."

### V4-PR6 — Demo Pack
- **Purpose:** packaged, clearly-labeled demos for regulated verticals.
- **Allowed scope:** `demos/*` with explicit `demo` / `mock-policy` labels.
- **Demos:** Coding Agent Action Firewall; Memory Poisoning Admission; Financial Kill Switch (mock-policy, labeled); Industrial Action Boundary (no guarantee claim); Public Sector Agent Governance.
- **Negative scope:** no real payment settlement, no marketplace, no production claim.
- **Acceptance:** every demo carries a visible "demo — not a guarantee" label; each maps to a real V4 verdict/receipt path.
- **Proof:** demo scripts run against real core (no fabricated verdicts).
- **Forbidden claims:** any production/guarantee language on a demo.

---

## 4. V4 non-goals (do NOT enter V4)

```
Supabase wallet
public agent marketplace
agent economy / real payment settlement
crypto / token system
full compliance platform
full endpoint-security product
foundation-model development
vector-DB / memory-database competition
"all connectors covered" claim
"production-ready enterprise platform" claim
```

Rationale (axiom-linked): the core (pre-action verdict + memory admission + Trust Receipt) must sit before any economy/marketplace layer. Wallet is a correct idea with wrong timing.

---

## 5. Cross-cutting PR rules (every V4 implementation PR)

- Fresh pristine worktree; never the dirty root.
- Narrow, explicit staging; never `git add .`.
- Runtime artifacts / `memory.json` / `memory.db` / logs never staged.
- Targeted tests + full `npm test` green before merge.
- No forbidden claims (section per-PR).
- One PR, one purpose. Blueprint big, PRs small.
