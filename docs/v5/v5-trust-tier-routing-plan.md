# V5 Trust-tier Routing Plan

## Status

Planning only.

This document defines the planned V5 trust-tier routing model. It does not
implement runtime routing, trust-tier enforcement, schemas, validators,
conformance runners, connector logic, package code, marketplace behavior, or
tests.

## Purpose

Trust-tier routing exists to let HUQAN adjust review intensity by verified
agent and connector evidence instead of treating every agent path equally.

The planned routing model binds tier decisions to:

- Agent Identity
- workspace and delegation scope
- policy version
- Trust Receipts
- Route Receipts
- Shared Trust Packages
- provenance
- conformance evidence
- connector coverage status

The routing layer must remain deterministic. Model output may provide advisory
signals, but model output cannot be the final authority for trust-tier
promotion, destructive action, network mutation, memory admission, or production
write authorization.

## Planned Tier Model

The planned V5 tiers are:

| tier | intended meaning | default posture |
| --- | --- | --- |
| `unverified` | identity, workspace, package, or connector evidence is missing or insufficient | maximum review, block risky actions |
| `probationary` | identity exists, but evidence is early, incomplete, or recently changed | elevated review |
| `trusted` | identity, workspace binding, provenance, receipts, and conformance evidence are valid for the scoped path | normal review |
| `privileged` | trusted path with explicit policy scope for reduced review on specific actions only | reduced review only inside policy scope |
| `root` | rare administrative or system authority, policy-bound, auditable, revocable | exceptional handling, never implicit |

The tier name is not a global badge. It is scoped to identity, workspace,
connector path, policy version, and evidence freshness.

## Deterministic Rule Boundary

Trust-tier routing must obey these boundaries:

- no LLM-as-final-tier-judge
- no model-only trust elevation
- no implicit privilege escalation
- no tier promotion without evidence
- no tier reuse across workspace without explicit policy
- revoked identity overrides any prior tier
- expired identity overrides any prior tier
- connector coverage gaps cap maximum tier
- unknown policy version caps maximum tier
- missing receipt or provenance caps maximum tier
- tampered package or receipt fails closed

The deterministic judge remains the final authority. AI classifiers may inform
review context, but they cannot grant tier elevation or bypass review.

## Routing Intensity

Planned routing intensity:

| tier | planned routing behavior |
| --- | --- |
| `unverified` | maximum review, block destructive or risky actions, no package trust |
| `probationary` | elevated review, stricter receipt and provenance checks |
| `trusted` | normal review, standard policy checks, evidence-linked routing |
| `privileged` | reduced review only for explicitly scoped actions with valid policy and receipts |
| `root` | rare, policy-bound, auditable, revocable, never inferred from model confidence |

Reduced review does not mean no review. It means the deterministic policy may
route certain scoped actions through a lighter review path when all required
evidence is valid.

## Tier Signals

Allowed future tier signals include:

- successful conformance fixtures
- valid Agent Identity
- valid workspace binding
- valid delegation scope
- valid Trust Receipt linkage
- valid Route Receipt linkage
- valid provenance
- connector coverage status
- route receipt consistency
- Shared Trust Package integrity
- reasoning metadata boundary
- policy version compatibility
- prior rejected, blocked, tampered, or expired events

These signals are inputs to deterministic policy. They do not become automatic
trust elevation by themselves.

## Downgrade And Escalation Rules

Planned downgrade or escalation triggers:

- tampered package
- tampered receipt
- revoked identity
- expired identity
- route mismatch
- connector not covered
- unknown policy version
- private memory leak
- workspace mismatch
- delegation scope mismatch
- repeated review events
- repeated block events
- failed conformance fixture
- missing provenance
- stale or missing receipt chain

Downgrades should be fail-closed. Escalations require explicit evidence and
policy compatibility.

## Relationship To Existing V5 Documents

This plan depends on the existing V5 planning set:

- `V5-PR0` defines the Shared Trust / Ecosystem blueprint.
- `LIT-0` defines source discipline for literature and external claims.
- `V5-PR1` defines the Agent Identity Contract.
- `V5-PR2` defines Shared Trust Package, Route Receipt, and Reasoning Metadata planning.
- `V5-PR3` defines the Conformance Suite fixture plan.
- `V5-PR4` defines Connector Coverage / Identity + Package Enforcement Matrix planning.

Trust-tier routing is the planning layer that explains how those pieces may
later influence deterministic routing intensity. It does not make those pieces
operational in this PR.

## Non-Claims

This PR does not claim:

- Trust-tier routing is implemented
- runtime routing is added
- trust-tier enforcement is added
- identity enforcement is added
- package enforcement is added
- schema, validator, or runner is added
- connector path is newly covered
- marketplace readiness exists
- production-ready trust-tier governance exists
- all agents are covered
- all connectors are covered
- model output can grant trust
- V5 implementation is complete

## Next Gates

This document supports the following planning order:

1. `V5-PR5` - Trust-tier routing plan
2. `V5-PR6` - A2A / Distributed Trust research note
3. `V5-IMPLEMENTATION-READINESS-0` - implementation gate audit

Anything beyond this remains future planning, not current implementation.

## Safe Claim

Safe current wording:

```txt
HUQAN has opened a V5 trust-tier routing planning gate to define how future
deterministic policies may route review intensity using identity, package,
receipt, provenance, conformance, and connector coverage evidence.
```

Unsafe wording:

```txt
HUQAN implements trust-tier routing.
HUQAN has production-ready trust-tier governance.
HUQAN automatically trusts agents based on model confidence.
HUQAN covers all agents and connectors.
HUQAN marketplace trust tiers are ready.
```
