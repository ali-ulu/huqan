# HUQAN / AXIOM — No-Mock Contract and Claim Boundaries

**Status:** V4-PR1 docs-only contract.
**Base at authoring:** `fab6e502f6490baedf8df5b9e08b47c2df3138bc` (`claude/practical-knuth-0ecsze`, post-#145).

---

## 1. The No-Mock Contract

> **V4 product surfaces must be backed by real HUQAN runtime state.**

This is the enforceable boundary that keeps every later V4 surface (Trust Console, Trust Receipt Viewer, Memory Admission Surface, demos) honest. If a surface displays a value, that value must trace back to a real decision produced by the runtime — not a placeholder, not a hardcoded sample, not a hypothetical.

### Allowed (must be real)

```
real kernel decision
real MCP path
real approval queue
real Trust Receipt primitive
real provenance/audit data
real memory admission state
```

### Allowed only if clearly labeled

```
demo data
mock policy
sample vertical scenario
illustrative receipt
```

Any of the above may appear in a demo pack (V4-PR6) or a UI walkthrough, but **only** with a visible, unambiguous label at the point of display — not in a footnote, not in documentation the viewer won't read. If a screen cannot carry the label in context, it does not ship with mock content.

### Forbidden

```
mock data presented as production behavior
receipt viewer over non-existent receipt-chain/export capability
full connector coverage claim from local stdio proof
production enterprise control plane claim
"guarantees truth"
"eliminates hallucinations"
```

Any PR that introduces a surface violating this list is out of contract and must be corrected before merge, regardless of how far along the implementation is.

---

## 2. Current allowed claims

### Allowed current claim

> **MCP Dogfood Product Proof GREEN for tested local stdio MCP path.**

This is the only MCP-coverage claim currently supported by evidence (FAZ2-5 local shared-state + approval-persistence tests). It must always be stated with the "tested local stdio MCP path" qualifier — never shortened to a general "MCP works" claim.

### Allowed conservative product claim

> **HUQAN is a tested deterministic trust kernel / partial trust layer with green FAZ2 hardening and green local stdio MCP dogfood proof.**

This is the ceiling for any external-facing claim until V4-PR2 through V4-PR5 land with their own evidence. It is deliberately conservative: "partial trust layer," not "trust platform"; "tested... hardening," not "enterprise-grade."

---

## 3. Explicit gap declarations

### Trust Receipt primitive gap

> **Trust Receipt Viewer cannot claim tamper-evident ledger or compliance export until receipt primitive hardening lands.**

As recorded in `docs/v4/v4-pr-plan.md` § 1: the current receipt (`lib/memory-admission-gate.js`) is content-addressed (`receiptId` = hash of decision content) but is **not** hash-chained (no `previous_receipt_hash`) and has **no export path**. V4-PR2.5 owns closing this gap. Until it merges and its own acceptance evidence exists, no surface may say "tamper-evident," "immutable ledger," or "audit export" about Trust Receipts.

### Connector Coverage Matrix

The matrix must separate what is tested from what is not, at all times:

| Connector / client path | Status | Evidence |
|---|---|---|
| MCP local stdio | **GREEN** | FAZ2-5 MCP shared-state + approval-persistence tests; #144 MCP dogfood product proof |
| Any other MCP transport (HTTP, SSE, remote) | **UNLABELED / NOT COVERED** | no test evidence at time of writing |
| Non-MCP tool-call surfaces (CLI, REST) | **Gated, not part of this matrix** | see FAZ2-6 CLI/REST mutation gate parity — a separate, already-closed concern |

The matrix is a living document: a connector path may only move from "unlabeled" to "GREEN" when a corresponding test exists and is cited. No path may be marked GREEN by inference or by analogy to a tested path.

---

## 4. Enforcement

Every V4 implementation PR (V4-PR2 onward) must include a "Non-claims" or equivalent section restating which of the above boundaries apply to that PR's surface, consistent with `docs/v4/v4-pr-plan.md`'s per-PR "Forbidden claims" fields. A PR that adds a user-visible surface without restating its claim boundary is incomplete, independent of whether its tests pass.
