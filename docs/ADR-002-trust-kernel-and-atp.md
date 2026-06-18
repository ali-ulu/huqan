# ADR-002: Trust Kernel and AXIOM Trust Protocol (ATP)

**Status:** Accepted
**Date:** 2026-06-02

## Context

AXIOM v0.7 introduced causal reasoning. It can explain what may break if a decision is applied.

v0.8 changes the next constraint:

```text
v0.7 asked: What breaks if I do this?
v0.8 asks: Why should this claim be trusted at all?
```

That requires AXIOM to become accountable, not just causal.

PR-0 is intentionally docs-only. It does not change runtime behavior in `graph.js`, `kernel.js`, `server.js`, `finalizer.js`, `causalSimulator.js`, package metadata, or tests.

## Decision

AXIOM v0.8 will be built around:

- a **Trust Kernel**
- **AXIOM Trust Protocol (`ATP`) v0.1**
- **AXIOM Verify Protocol (`AVP`)**, which is the verify subset of ATP

## Trust Kernel

The Trust Kernel is the source-of-truth layer for claim accountability.

Responsibilities:

- manage provenance and source binding
- apply trust policy before canonical write
- keep audit history append-only
- enforce lightweight workspace scoping
- route conflicts into canonical, pending, or rejected lanes
- expose portable trust concepts instead of storage-specific assumptions

## ATP and AVP

- **ATP** is the broader portable trust protocol for claims, provenance, conflict routing, audit, and exchange.
- **AVP** is the verification-facing subset of ATP for verify request/response flows.

AVP is not separate from ATP. It is the verification slice of ATP.

## The Eight Laws of Trust

1. No information enters the canonical graph without provenance.
2. No causal law enters the canonical graph without provenance.
3. Flagged information goes to `pending_claims`, never directly to the active graph.
4. Rejected information goes to `rejected_claims` and the audit log.
5. The audit log is append-only.
6. Workspace isolation is lightweight but mandatory.
7. Trust outcomes are derived from trust policy, not hardcoded trust.
8. The `.axiom` format is an exchange format, not a runtime storage engine.

## Core Terms

- **canonical graph**: the accepted active graph used by runtime reasoning
- **candidate claim**: a new claim awaiting trust evaluation
- **pending claim**: a flagged claim quarantined for review
- **rejected claim**: a claim explicitly rejected by trust policy
- **provenance record**: the source binding object attached to a claim
- **trust policy**: the configuration that decides `accept`, `flag`, or `reject`

## Operational Modes

### `strictProvenance = false`

Backward-compatible mode.

- missing provenance is tolerated
- legacy flows remain usable
- warnings are acceptable
- default source metadata may be added by future ingestion policy

This mode exists to preserve older learn/ingest paths while the system is moved
toward accountable provenance. It produces **compatibility provenance**, not
ATP-grade accountable provenance.

Compatibility provenance means:

- missing fields may be auto-filled so older flows keep working
- warnings are part of the contract
- invalid `sourceType` may be normalized to `system`
- the result is usable for backward-compatible runtime continuity
- the result must not be described as strong, explicit, or fully accountable provenance

Compatibility provenance is therefore allowed, but it is a weaker contract than
strict provenance. It keeps runtime continuity without claiming that missing
metadata is equal to fully declared source metadata.

### `strictProvenance = true`

Governance mode.

- missing provenance is a hard failure
- the claim should not be canonically accepted
- boundaries should surface a provenance-specific error
- this mode is intended for accountable ingestion paths

Strict provenance is the accountable path for ATP-grade ingestion and
conformance-sensitive flows.

Strict provenance means:

- required provenance fields must be explicit
- invalid `sourceType` must fail closed
- boundaries must reject missing or malformed provenance instead of normalizing it
- callers are expected to provide accountable source metadata up front

This distinction is intentional:

- non-strict mode preserves backward compatibility
- strict mode preserves accountable trust semantics

The two modes are not equally strong, and documentation, tests, and future
changes must keep that boundary visible.

## Provenance Contract Boundary

The provenance contract has two intentionally different levels:

1. **Compatibility provenance**
   - used by backward-compatible non-strict paths
   - may auto-fill missing fields
   - may normalize invalid `sourceType` to `system`
   - carries warnings
   - is acceptable for continuity, migration, and legacy learn flows

2. **Accountable provenance**
   - required by strict provenance paths
   - required by ATP/conformance-sensitive validation
   - requires explicit provenance fields such as `sourceType`, `sourceRef`,
     `sourceTitle`, `actor`, `timestamp`, and `workspaceId`
   - must fail closed on invalid or missing metadata

The system must not present compatibility provenance as if it were accountable
provenance. Missing metadata that was auto-filled for compatibility is not the
same thing as explicitly supplied provenance.

This is why invalid `sourceType -> system` normalization is acceptable only in
non-strict compatibility mode. In strict mode, the same input must fail closed.

## Conflict Routing

Trust policy routes a candidate claim into one of three outcomes:

- `accept` -> canonical graph
- `flag` -> `pending_claims`
- `reject` -> `rejected_claims` + append-only `audit_log`

This routing contract belongs to ATP, not to a specific UI or transport.

## Storage Strategy

- SQLite remains the canonical runtime store for v0.8 work.
- A storage adapter layer should decouple ATP concepts from physical storage.
- Workspace-aware indexing is expected for trust-critical tables.
- `.axiom` export is for exchange and portability, not live runtime mutation.

## Workspace Scoping

Workspace isolation is intentionally lightweight in v0.8:

- claims carry `workspaceId`
- provenance carries `workspaceId`
- trust evaluation and routing happen within workspace scope
- cross-workspace federation is not part of PR-0

## `.axiom` Exchange Format

`.axiom` is the portable package format for:

- claims
- nodes
- edges
- provenance
- audit
- pending claims
- rejected claims
- signatures

It is an interoperability format, not the internal runtime database engine.

## Strategic Standardization Note

AXIOM should not position ATP as a closed product format.

The goal is to become the default trust layer for AI systems by making ATP portable, testable, and implementation-independent.

ATP should eventually support:

- reference implementation through AXIOM
- conformance suite
- external implementations
- Trust Receipt user experience
- ATP-compatible badge
- future SDKs and wrappers

The strategic wedge is staged:

- v0.8 starts with technical founders and AI builders
- v0.9 expands into organizational and company memory
- v1.0 can become a public standard for accountable AI systems

Important language:

- AXIOM does not force adoption.
- AXIOM becomes the trust layer serious AI systems prefer.

## Docs-Only Public Concepts

These remain documentation-level concepts in PR-0:

- **Trust Receipt**
- **Claim Passport**
- **ATP Compatibility Badge**

PR-0 does not implement them in runtime.

## v0.8 Non-Scope

- full enterprise governance suite
- full RBAC and multi-tenant SaaS orchestration
- full world model simulation
- probabilistic prediction engine
- cryptographic multi-sig certification
- broad connector fleet in the first trust milestone

## Consequences

Positive:

- clear accountability model for future runtime work
- clean separation between knowledge and trust
- a portable protocol direction that can survive backend changes

Tradeoffs:

- higher metadata overhead
- stricter ingestion requirements
- more explicit policy work before canonical writes

## Roadmap

- PR-0: ADR + public ATP/AVP docs
- PR-1: provenance schema
- PR-2: trust policy config + provenance ingestion
- PR-3: audit log core
- PR-4: workspace scoping + SQLite indexes
- PR-5: conflict routing + quarantine
- PR-6: provenance-aware GitHub connector
- PR-7: provenance query API + trust dashboard
- PR-8: ATP/AVP v0.1 hardening + conformance suite
- PR-8.5: `.axiom` exchange / package format draft
- PR-9: minimal `axiom-verify` package skeleton
- PR-10: v0.8 release prep
