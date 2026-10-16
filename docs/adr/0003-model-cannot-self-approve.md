# ADR 0003: A model cannot approve its own mutation

## Status
Accepted

## Context
HUQAN allows agents and models to propose actions that can affect durable state. If the same actor can both propose a mutation and satisfy the approval required for it, approval becomes circular evidence rather than an independent control.

## Decision
A model or agent that proposes a mutation cannot approve that mutation on its own behalf. Where policy requires review, approval must come from an independent human or oversight authority recognized by the approval runtime. Model-generated confidence, rationale, or self-evaluation may be recorded as evidence but never substitutes for the required approval.

The rule applies at mutation boundaries, including indirect tool-mediated mutations. Adapters must preserve proposer identity so the approval layer can distinguish proposal from authorization.

## Consequences
- Required oversight cannot be bypassed by self-attestation.
- Automation remains possible for actions whose policy explicitly permits automatic execution.
- Identity/provenance must survive through adapters and approval records.
- Tests should reject self-approval whenever independent approval is required.

## References
- `lib/human-oversight-approval-runtime.js`
- `lib/memory-admission-gate.js`
- `docs/adr/ADR-005-v3-approval-runtime-and-memory-admission.md`
- Issue #2640 (A4)
