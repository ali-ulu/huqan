# V5 Agent Identity Contract

## Status

Planning only.

This document defines a contract plan and future schema shape for V5.
It does not implement runtime identity enforcement, validators, connectors, or
shared trust package verification.

## Purpose

The Agent Identity Contract exists to make actor binding explicit inside shared
trust flows.

Its job is to:

- distinguish agent identity from model identity
- distinguish agent identity from user identity
- bind actions to actor, owner, and workspace
- constrain delegation scope
- connect actions to receipts and provenance
- support deterministic audit, suspension, expiry, and revocation

HUQAN is not acting as a generic identity provider in this plan.
HUQAN's role is narrower: it evaluates identity claims as deterministic trust
inputs before an action is allowed, reviewed, dry-run-only, or blocked.

## Core Boundary

Storage, receipt, and provenance layers may persist identity-related evidence.
They are not the final authority.

Final authority must remain deterministic:

- no LLM-as-final-judge
- no model-only trust tier assignment
- no implicit privilege escalation
- no action without workspace binding
- no delegation without explicit scope
- no expired or revoked identity allowed

## Planned Contract Fields

The future Agent Identity Contract should carry these fields:

- `agent_id`
- `agent_type`
- `display_name`
- `owner_actor_id`
- `workspace_id`
- `delegation_scope`
- `allowed_tools`
- `allowed_memory_scopes`
- `allowed_connectors`
- `risk_tier`
- `trust_tier`
- `policy_version`
- `issued_at`
- `expires_at`
- `revoked_at`
- `revocation_reason`
- `parent_agent_id`
- `delegation_chain`
- `receipt_refs`
- `provenance_refs`
- `audit_requirements`
- `verification_status`

## Field Intent

| Field | Purpose |
| --- | --- |
| `agent_id` | Stable identifier for the agent inside the trust boundary. |
| `agent_type` | Declares whether the actor is local, remote, delegated, internal, or ecosystem-facing. |
| `display_name` | Human-readable label for audit and operator review. |
| `owner_actor_id` | Accountable owner: human, org, service, or system principal. |
| `workspace_id` | Explicit workspace binding. No workspace means no valid action context. |
| `delegation_scope` | Bounded set of actions or authority the agent may exercise. |
| `allowed_tools` | Tool allowlist or policy reference for action execution. |
| `allowed_memory_scopes` | Memory namespaces or context surfaces the agent may read or propose to mutate. |
| `allowed_connectors` | Connector boundaries the agent may traverse when connector trust is later implemented. |
| `risk_tier` | Risk classification used by deterministic policy. |
| `trust_tier` | Trust tier used by deterministic policy. This must never be model-assigned by itself. |
| `policy_version` | Policy version under which the identity was evaluated. |
| `issued_at` | Issuance timestamp for the contract envelope. |
| `expires_at` | Expiry timestamp after which the identity is stale or invalid. |
| `revoked_at` | Timestamp marking explicit revocation. |
| `revocation_reason` | Structured reason for revocation or suspension. |
| `parent_agent_id` | Parent identity when the agent is delegated or spawned from another agent. |
| `delegation_chain` | Ordered ancestry chain used to validate delegation integrity. |
| `receipt_refs` | Receipts proving issuance, delegation, approval, suspension, or revocation events. |
| `provenance_refs` | Provenance links for evidence, route, and policy context. |
| `audit_requirements` | Required fields or evidence for actions executed under this identity. |
| `verification_status` | Deterministic verification state such as pending, verified, suspended, revoked, or expired. |

## Lifecycle

The planning contract expects these lifecycle states:

- `unregistered`
- `registered`
- `probationary`
- `trusted`
- `privileged`
- `suspended`
- `revoked`
- `expired`

Meaning:

- `unregistered`: no valid identity exists yet
- `registered`: identity exists but has minimal trust only
- `probationary`: identity exists but remains constrained or under review
- `trusted`: identity is valid for bounded normal operations
- `privileged`: identity has expanded authority under explicit deterministic policy
- `suspended`: identity remains known but temporarily blocked
- `revoked`: identity must fail closed and cannot execute
- `expired`: identity exists historically but cannot execute until renewed

## Deterministic Rules

The future implementation must preserve these rules:

1. Missing `agent_id` is invalid.
2. Missing `workspace_id` is invalid for action execution.
3. Expired identity must block or reject.
4. Revoked identity must block or reject.
5. Suspended identity must not silently execute.
6. Delegation must be explicit, bounded, and auditable.
7. Tool scope must not imply memory scope.
8. Memory scope must not imply connector or production write scope.
9. Trust tier must not override missing or invalid receipts.
10. No downstream action may rely on model output alone for identity authorization.

## Relationship To Existing Planning Gates

This contract plan depends on and maps back to:

- `V5-PR0` Shared Trust / Ecosystem Blueprint
- `LIT-0` Academic Source Verification
- future shared trust package / receipt bundle planning
- future route receipt / reasoning metadata planning
- future connector coverage matrix
- future conformance suite

The point of this document is not to prove the identity layer already exists.
Its point is to freeze the contract vocabulary before later schema planning,
conformance planning, and enforcement sequencing.

## Future Conformance Requirements

These are future tests and fixtures only.
They are not implemented by this PR.

- missing `agent_id` -> invalid
- expired identity -> block or reject
- revoked identity -> block or reject
- mismatched `workspace_id` -> block or reject
- tool outside `allowed_tools` -> review or block
- memory access outside `allowed_memory_scopes` -> review or block
- connector outside `allowed_connectors` -> review or block
- broken `delegation_chain` -> block or reject
- unknown `policy_version` -> review or block
- missing `receipt_refs` linkage -> invalid for shared trust package flows

## Planned Validation Shape

This is a schema-plan note, not a schema implementation.

The future validation layer should answer questions like:

- is the identity envelope complete
- is the workspace binding explicit
- is the delegation chain intact
- is the receipt linkage present
- is the policy version recognized
- is the lifecycle state compatible with the requested action

Validation authority must remain deterministic and auditable.

## Non-Claims

This PR does not claim:

- Agent Identity is implemented
- runtime enforcement is added
- connector identity is already trusted
- marketplace security is implemented
- shared trust package verification is implemented
- V5 implementation is complete
- HUQAN is production-ready
- HUQAN guarantees truth
- HUQAN eliminates hallucinations
- all agents or all connectors are covered

## Next Gates

This document supports the following planning order:

1. `V5-PR1` - Agent Identity Contract docs/schema plan
2. `V5-PR2` - Shared Trust Package / Route Receipt / Reasoning Metadata docs/schema plan
3. `V5-PR3` - Conformance Suite fixture plan
4. `V5-PR4` - Connector Coverage / Identity Enforcement Matrix
5. `V5-PR5` - Trust-tier routing plan

Anything beyond that remains future planning, not current implementation.

## Safe Claim

Safe current wording:

```txt
HUQAN has opened a deterministic Agent Identity Contract planning gate for V5.
```

Unsafe wording:

```txt
HUQAN already enforces agent identity across the ecosystem.
HUQAN has production-ready identity governance.
HUQAN covers every agent and connector path.
```
