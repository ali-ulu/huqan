# ADR-005: V3 Approval Runtime and Memory Admission Gate

Status: Proposed

## 1. Context

AXIOM currently returns four top-level gate decisions:

- `allow`
- `review`
- `dry_run_only`
- `block`

That split is sufficient for static policy decisions, but it is not yet a full workflow. In the current system, `review` is only a classification. It does not yet become a durable approval request, a queue item, a decision receipt, or a memory admission event.

V3 turns `review` into a local-first control plane for approval, audit, and memory integrity.

Canonical sentence:

> Models generate. Agents act. Memory stores. HUQAN judges.

## 2. Problem Statement

The current product can identify that an action needs review, but it cannot yet:

- create an approval request object
- place the request into a pending queue
- approve or reject the request
- produce a reviewed action receipt or blocked action receipt
- gate memory admission with provenance and receipt requirements
- preserve a local audit trail for the decision lifecycle

Without those pieces, `review` stays informational instead of operational.

## 3. Decision

We define V3 as an approval runtime plus a memory admission gate.

V3 does not add runtime code in this PR. This ADR only defines the boundaries, the actors, the request/decision lifecycle, and the intended future PR sequence.

## 4. V3 Components

V3 is composed of the following conceptual pieces:

- Approval Request Schema
- Pending Approval Queue
- Approval Decision Flow
- Memory Admission Gate
- Reviewed / Blocked Action Receipts
- MCP Approval Status Tools
- Local-first Audit Integration

These are architecture boundaries, not yet executable features.

## 5. HUQAN Agent Control Plane Mapping

V3 sits under the HUQAN Agent Control Plane and connects to these existing surfaces:

- Action Gate
- Agent Identity Contract
- Trust Receipt Ledger
- Memory State Integrity
- Internal A2A Exchange

V3-PR0 only documents these boundaries. It does not implement the control plane.

## 6. Agent Identity Contract

No agent action should be evaluated without an actor identity.

The future identity contract must define:

- `agent_id`
- `owner`
- `workspace_id`
- `role`
- `risk_tier`
- `allowed_tools`
- `denied_tools`
- `memory_permissions`
- `approval_policy`
- `expiry`
- `delegation_scope`
- `network_scope`
- `filesystem_scope`
- `a2a_scope`
- `audit_subject_id`

Rules:

- identity is mandatory for action evaluation
- identity must be stable enough for audit and receipts
- policy decisions must be attributable to a concrete actor
- anonymous action execution is out of scope for V3

## 7. Memory Admission Gate

V3 introduces a memory admission gate for any proposed memory write.

The future gate must require:

- proposed memory write payload
- provenance reference
- trust policy reference
- approval status
- canonical admission decision
- rejection or quarantine path
- mutation receipt

Rules:

- no silent memory overwrite
- no unreceipted memory mutation
- no canonical memory admission without provenance
- reviewed memory write must produce a receipt

The memory admission gate is not a storage rewrite. It is a policy and audit boundary around mutation.

## 8. Decision Lifecycle

The intended V3 lifecycle is:

1. An action is classified as `review`.
2. A reviewable request is materialized as an approval request.
3. The request enters a pending queue.
4. A human or trusted local policy produces approve or reject.
5. The system emits a reviewed action receipt or blocked action receipt.
6. If the action proposes memory mutation, the memory admission gate validates provenance and receipt requirements.
7. The local audit trail records the final decision.

## 9. What V3 Is Not

V3 is explicitly not:

- UI rewrite
- plugin marketplace
- Dream expansion
- Self-Healer
- GitHub App
- L-ASIC
- TypeScript migration
- Rust rewrite
- cloud dashboard
- enterprise RBAC
- V4 Workbench
- V5 ecosystem

## 10. Proposed PR Sequence

The intended implementation sequence is:

- V3-PR0: ADR / blueprint
- V3-PR1: Approval request schema
- V3-PR2: Pending approval queue
- V3-PR3: Approve/reject flow
- V3-PR4: Memory Admission Gate
- V3-PR5: MCP approval status tools
- V3-PR6: Receipt/audit integration
- V3-PR7: V3 smoke + docs

Each PR should remain narrow and should not mix unrelated runtime changes.

## 11. Acceptance Criteria for V3-PR0

V3-PR0 is complete when:

- the V3 problem is defined
- the conceptual components are named
- the agent identity contract is bounded
- the memory admission gate rules are explicit
- the non-goals are explicit
- the implementation sequence is documented
- no runtime code has been changed

## 12. Consequences

Positive consequences:

- `review` becomes a real workflow boundary
- memory mutation becomes auditable
- approval decisions become local-first and explicit
- actor identity becomes mandatory for action evaluation

Tradeoffs:

- more conceptual surface area before runtime implementation
- more policy and audit design work before feature delivery
- future PRs must stay disciplined to avoid scope drift

## 13. Out of Scope

This ADR does not implement:

- approval storage
- queue processing
- API endpoints
- MCP tools
- server changes
- kernel changes
- memory runtime changes
- version bumps
- release tags

## 14. Recommendation

Proceed with V3-PR1 only after this blueprint is accepted. All runtime work must stay behind this boundary.
