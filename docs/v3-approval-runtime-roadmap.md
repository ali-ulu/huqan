# V3 Approval Runtime Roadmap

Branch: `docs/v3-approval-runtime-blueprint`

Base: `main / 2ae8b49`

## Purpose

This roadmap turns the V3 blueprint into a disciplined sequence of small PRs.

V3 is the approval runtime and memory admission gate for HUQAN Agent Control Plane.

## Scope

This roadmap is docs-only. It does not add runtime code, endpoints, queueing logic, MCP tools, or package changes.

## V3 Sequence

### V3-PR0 - ADR / Blueprint

Goal:

- define the approval runtime boundary
- define the memory admission gate boundary
- define the identity contract boundary

Exit criteria:

- ADR exists
- roadmap exists
- no runtime code changed

### V3-PR1 - Approval Request Schema

Goal:

- define the approval request payload shape
- define the required identity and provenance fields
- define the review classification inputs

Exit criteria:

- schema is documented
- sample payload is documented
- no runtime execution added yet

### V3-PR2 - Pending Approval Queue

Goal:

- define how reviewable actions enter a pending queue
- define queue states and transitions
- define local-first persistence expectations

Exit criteria:

- queue lifecycle is documented
- queue state machine is documented

### V3-PR3 - Approve / Reject Flow

Goal:

- define the approval decision path
- define the rejection path
- define reviewed action receipts and blocked action receipts

Exit criteria:

- decision lifecycle is documented
- receipt boundaries are documented

### V3-PR4 - Memory Admission Gate

Goal:

- define provenance checks for proposed memory writes
- define canonical admission rules
- define quarantine and rejection outcomes

Exit criteria:

- memory admission policy is documented
- no silent overwrite rule is explicit

### V3-PR5 - MCP Approval Status Tools

Goal:

- define read-only MCP surfaces for approval status
- define how agents inspect queue and decision state

Exit criteria:

- MCP status surface is documented
- tool boundaries stay read-only

### V3-PR6 - Receipt / Audit Integration

Goal:

- define how approval and memory receipts are recorded
- define local audit trail requirements
- define traceability requirements for actor identity

Exit criteria:

- receipt schema is documented
- audit trace boundaries are documented

### V3-PR7 - V3 Smoke + Docs

Goal:

- define the final smoke set for V3
- document the release gating expectations

Exit criteria:

- V3 smoke checklist is documented
- docs are stable enough for implementation handoff

## Guardrails

- Do not mix V3 with UI expansion
- Do not mix V3 with Dream expansion
- Do not mix V3 with Self-Healer
- Do not mix V3 with GitHub App work
- Do not mix V3 with package/version changes
- Do not mix V3 with server/kernel/runtime implementation

## Recommended Execution Rule

One PR, one purpose. If a future V3 PR needs multiple concerns, split it before implementation.
