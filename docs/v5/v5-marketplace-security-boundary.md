# V5 Marketplace / Ecosystem Security Boundary

## Status

Planning only. No marketplace, package distribution, badge, or conformance
runtime is implemented by this document.

## Purpose

The marketplace boundary prevents HUQAN from becoming a plugin marketplace
before trust contracts exist.

V5 must define what can be shared, what must never be shared, how shared trust
packages are verified, and how untrusted ecosystem inputs are rejected.

## What Can Be Shared

Future ecosystem sharing may include:

- redacted Trust Receipt bundles
- verdict summaries
- provenance references
- connector coverage declarations
- conformance results
- non-claim declarations
- policy version metadata

## What Must Never Be Shared

The ecosystem layer must not share:

- secrets
- API keys
- raw private memory content
- private workspace data
- unredacted user data
- local `.env` files
- runtime databases
- approval tokens
- private connector credentials

## Verification Boundary

Receipts and packages must be verified through deterministic checks:

- receipt hash validation
- receipt chain validation
- evidence hash validation
- producer identity match
- policy version compatibility
- connector coverage match
- no-mock declaration check

## Third-Party Package Rejection

Third-party packages must be rejected or marked invalid when:

- producer is unknown
- identity is expired or revoked
- signature/hash check fails
- required provenance is missing
- connector coverage is overstated
- package contains secrets
- package claims readiness beyond evidence

## Connector Permission Boundary

Connector permission must be bounded by:

- agent identity
- workspace
- delegated tool scope
- memory scope
- expiry
- trust policy version
- connector coverage status
- audit requirements

Connector access must not be inferred from package presence alone.

## Marketplace Timing Rule

Marketplace implementation is blocked until:

- Agent Identity Contract is defined
- Shared Trust Package format is defined
- Conformance Suite plan is accepted
- Connector Coverage Matrix is explicit
- no-mock policy is enforced for ecosystem claims

## Non-Claims

This document does not claim:

- marketplace exists
- packages can be safely installed
- badges or conformance marks are ready
- external connector paths are trusted
- V5 implementation is complete
