# V5 Shared Trust Package / Route Receipt / Reasoning Metadata Plan

## Status

Planning only.

This document defines the planned Shared Trust Package shape, route receipt
model, reasoning metadata boundary, verification statuses, and future
conformance expectations for V5.

It does not implement package generation, package parsing, schema validation,
runtime receipt enforcement, connector behavior, marketplace behavior, or
shared trust verification.

## Purpose

A Shared Trust Package is the future portable evidence unit for HUQAN trust
state.

It exists to:

- move trust evidence between agents, workspaces, and systems
- bundle verdicts, receipts, provenance references, and policy metadata
- support later replay and audit
- preserve local-first trust boundaries
- avoid treating external packages as trusted by default

The package is not a trust grant by itself. A consumer must still verify
identity, provenance, policy compatibility, receipt integrity, route integrity,
and connector coverage before using the package as evidence.

## Package Fields

The planned package envelope should include:

- `package_id`
- `package_version`
- `producer_agent_id`
- `producer_workspace_id`
- `created_at`
- `policy_version`
- `trust_contract_version`
- `identity_contract_ref`
- `receipt_bundle`
- `route_receipts`
- `reasoning_metadata`
- `evidence_refs`
- `provenance_refs`
- `verification_status`
- `signature_placeholder`
- `hash_placeholder`
- `non_claims`
- `consumer_requirements`

## Field Intent

| Field | Purpose |
| --- | --- |
| `package_id` | Stable package identifier. |
| `package_version` | Format version for future compatibility checks. |
| `producer_agent_id` | Agent identity that produced the package. |
| `producer_workspace_id` | Workspace where the package was produced. |
| `created_at` | Package creation timestamp. |
| `policy_version` | Policy version used to build or evaluate package contents. |
| `trust_contract_version` | Shared trust contract version used by producer and consumer. |
| `identity_contract_ref` | Link to the Agent Identity Contract evidence used by the package. |
| `receipt_bundle` | Trust Receipts included or referenced by this package. |
| `route_receipts` | Route/hop receipts describing handoff or delegation movement. |
| `reasoning_metadata` | Bounded deterministic explanation metadata. |
| `evidence_refs` | References to supporting evidence, artifacts, or fixtures. |
| `provenance_refs` | Provenance links needed to verify origin and custody. |
| `verification_status` | Current deterministic status of the package. |
| `signature_placeholder` | Future signature slot; not implemented by this PR. |
| `hash_placeholder` | Future package hash slot; not implemented by this PR. |
| `non_claims` | Explicit claims this package does not make. |
| `consumer_requirements` | Requirements a consumer must satisfy before trusting package evidence. |

## Draft Envelope Shape

This example is illustrative only. It is not a runtime schema.

```json
{
  "package_id": "string",
  "package_version": "string",
  "producer_agent_id": "string",
  "producer_workspace_id": "string",
  "created_at": "timestamp",
  "policy_version": "string",
  "trust_contract_version": "string",
  "identity_contract_ref": "string",
  "receipt_bundle": [],
  "route_receipts": [],
  "reasoning_metadata": {},
  "evidence_refs": [],
  "provenance_refs": [],
  "verification_status": "unverified",
  "signature_placeholder": null,
  "hash_placeholder": null,
  "non_claims": [],
  "consumer_requirements": []
}
```

## Route Receipt / Hop Model

Route receipts describe how trust evidence moves across an agent, workspace, or
system boundary.

The planned route receipt fields are:

- `route_receipt_id`
- `parent_receipt_id`
- `from_agent_id`
- `to_agent_id`
- `from_workspace_id`
- `to_workspace_id`
- `action_ref`
- `handoff_reason`
- `delegation_scope`
- `condition`
- `timestamp`
- `policy_version`
- `verification_status`

## Route Receipt Intent

| Field | Purpose |
| --- | --- |
| `route_receipt_id` | Stable id for this handoff or hop. |
| `parent_receipt_id` | Receipt that authorized or explains the hop. |
| `from_agent_id` | Producer or sender agent identity. |
| `to_agent_id` | Consumer or receiving agent identity. |
| `from_workspace_id` | Source workspace boundary. |
| `to_workspace_id` | Destination workspace boundary. |
| `action_ref` | Action, tool call, task, or evidence item being handed off. |
| `handoff_reason` | Deterministic reason for the handoff. |
| `delegation_scope` | Scope allowed by the handoff. |
| `condition` | Constraints that must hold for the hop to remain valid. |
| `timestamp` | Hop timestamp. |
| `policy_version` | Policy version used to evaluate the hop. |
| `verification_status` | Current verification state of the hop. |

## Reasoning Metadata Boundary

Reasoning metadata can include deterministic, auditable explanation fields.

Allowed metadata:

- deterministic rule ids
- decision factors
- evidence ids
- contradiction markers
- support markers
- unknown markers
- downgrade reasons
- risk flags
- policy version
- verifier version

Forbidden metadata:

- hidden chain-of-thought
- raw secrets
- private memory outside allowed scope
- unverified external claims as canonical truth
- model-only judgment as final authority
- production credentials
- private connector payloads outside declared scope

Reasoning metadata must explain deterministic verification without exporting
private reasoning traces or sensitive runtime state.

## Verification Status

The planned package verification statuses are:

- `unverified`
- `structurally_valid`
- `policy_matched`
- `provenance_matched`
- `identity_matched`
- `replay_verified`
- `rejected`
- `expired`
- `revoked`

Meaning:

- `unverified`: package has not been checked by the consumer
- `structurally_valid`: required fields and envelope shape are present
- `policy_matched`: policy version is recognized and compatible
- `provenance_matched`: provenance references resolve and match expected origin
- `identity_matched`: producer identity and contract references match
- `replay_verified`: package can be replayed or independently verified later
- `rejected`: package failed verification
- `expired`: package or policy is stale
- `revoked`: identity, package, or route authority has been revoked

## Relationship To Existing Gates

This document maps back to:

- `V5-PR0` Shared Trust / Ecosystem Blueprint
- `LIT-0` Academic Source Verification
- `V5-PR1` Agent Identity Contract
- future conformance suite
- future connector coverage matrix
- future marketplace/security boundary

The Shared Trust Package depends on Agent Identity. A package without a valid
identity contract reference must remain invalid for shared trust use.

## Future Conformance Requirements

These are future tests and fixtures only. They are not implemented by this PR.

- missing `package_id` -> invalid
- missing `producer_agent_id` -> invalid
- missing `identity_contract_ref` -> invalid
- route receipt parent mismatch -> invalid
- revoked identity -> rejected
- expired `policy_version` -> review or reject
- tampered hash -> rejected
- missing provenance for canonical claim -> invalid
- external package cannot become trusted by default
- hidden or private memory leak -> rejected

## Future Consumer Requirements

A future consumer should verify:

- producer identity exists and is not revoked
- workspace boundary is explicit
- policy version is known
- package version is compatible
- receipt bundle hashes and chains are intact
- route receipts match parent receipt and delegation scope
- reasoning metadata contains no hidden chain-of-thought or secrets
- provenance references match the claimed origin
- non-claims are preserved

## Non-Claims

This PR does not claim:

- Shared Trust Package is implemented
- package writer or reader exists
- runtime package enforcement is added
- schema validators are added
- connector path is newly covered
- marketplace security is provided
- production-ready shared trust exists
- all-agent or all-connector package compatibility exists
- hidden reasoning or chain-of-thought export is supported
- V5 implementation is complete

## Next Gates

This document supports the following planning order:

1. `V5-PR2` - Shared Trust Package / Route Receipt / Reasoning Metadata docs/schema plan
2. `V5-PR3` - Conformance Suite fixture plan
3. `V5-PR4` - Connector Coverage / Identity + Package Enforcement Matrix
4. `V5-PR5` - Trust-tier routing plan
5. `V5-PR6` - A2A / Distributed Trust research note

Anything beyond this remains future planning, not current implementation.

## Safe Claim

Safe current wording:

```txt
HUQAN has opened a Shared Trust Package planning gate for portable trust
evidence, route receipts, and bounded reasoning metadata.
```

Unsafe wording:

```txt
HUQAN already exports production-ready shared trust packages.
HUQAN verifies all external trust packages by default.
HUQAN supports marketplace-ready package distribution.
HUQAN exports hidden chain-of-thought for audit.
```
