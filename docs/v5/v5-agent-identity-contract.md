# V5 Agent Identity Contract

## Status

Planning only. No runtime identity contract is implemented by this document.

## Purpose

The Agent Identity Contract defines the minimum identity envelope an external
agent must carry before HUQAN can evaluate that agent in a shared trust context.

HUQAN is not an identity provider in this plan. HUQAN evaluates identity claims
as evidence and scope inputs for deterministic judgment.

## Required Fields

A future agent identity envelope should include:

- agent id
- actor / owner
- workspace
- delegation scope
- allowed tools
- allowed memory scope
- expiry
- revocation status
- trust policy version
- receipt linkage
- audit requirements

## Field Intent

| Field | Purpose |
| --- | --- |
| `agentId` | Stable agent identifier within the trust boundary. |
| `actor` / `owner` | Human, org, or system accountable for the agent. |
| `workspaceId` | Workspace where the identity is valid. |
| `delegationScope` | Actions the agent may request or propose. |
| `allowedTools` | Tool allowlist or policy reference. |
| `allowedMemoryScope` | Memory namespaces the agent may read or request to mutate. |
| `expiresAt` | Time after which identity is stale. |
| `revocation` | Explicit invalidation state or reference. |
| `trustPolicyVersion` | Policy version used by the judge. |
| `receiptRefs` | Receipts proving identity, delegation, or revocation events. |
| `auditRequirements` | Required audit fields for actions under this identity. |

## Rules

- Missing identity must not be treated as trusted identity.
- Expired identity must fail closed or require review.
- Revoked identity must be rejected.
- Tool scope must not imply memory scope.
- Memory scope must not imply network or production write scope.
- Receipt linkage must be verifiable before being used as trust evidence.

## Future Work

V5-PR1 may turn this plan into a docs/schema plan. Runtime enforcement remains
out of scope until a later approved implementation gate.

## Non-Claims

This document does not claim:

- agent identity enforcement exists
- external agents are already covered
- connector identity is already trusted
- V5 implementation is complete
