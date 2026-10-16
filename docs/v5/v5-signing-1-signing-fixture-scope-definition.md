# V5-SIGNING-1 - Signing Fixture Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `V5-SIGNING-0_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ e4d92427ba212a14e5b6431441f1cbb3591aa63b`

## Purpose

`V5-SIGNING-1` defines the future fixture families for Shared Trust Package
signing. It does not add fixture files, keys, signatures, signing code, or
verification code.

The existing writer and reader flow remains local and unsigned:

`writer -> local candidate -> reader read/shape validation`

Signing fixtures must be treated as future contract evidence, not as proof that
signing capability exists.

## Scope Boundary

This gate may document:

- future signing fixture categories
- expected fixture envelope shape
- deterministic metadata expectations
- valid and invalid signing scenarios
- separation between signing and verification
- explicit non-claims and stop conditions
- the next fixture/test gate sequence

This gate must not create any JSON fixture or implementation artifact.

## Future Fixture Envelope

A later fixture-only gate may use a clearly marked envelope containing fields
such as:

- `fixtureType`
- `caseId`
- `description`
- `signingInput`
- `expected`
- `nonClaims`

The exact field contract must be finalized by a later fixture implementation
gate. This document does not modify the existing Shared Trust Package schema.

## Future Valid Fixture Categories

Future valid fixtures may cover:

- canonical unsigned package candidate prepared for signing
- signed artifact with deterministic signature metadata
- signed artifact with an explicit key identifier
- signed artifact with an explicitly supported algorithm identifier
- signed artifact preserving package identity and nonClaims
- signed artifact whose payload digest is deterministic
- signing preparation that does not imply verification

These categories are planning labels only. No signed artifact is created here.

## Future Invalid Fixture Categories

Future invalid fixtures should cover fail-closed behavior for:

- missing signing input
- missing package identity
- missing key identifier
- missing algorithm identifier
- unsupported algorithm
- malformed signature encoding
- empty signature value
- signature claim without signature data
- unsigned artifact falsely marked as signed
- signing metadata that claims verification
- signing metadata that claims trust or authorization
- signing metadata that claims transport or exchange
- signing metadata that claims A2A, connector, marketplace, or AgentAction

Each invalid fixture should have a deterministic expected status and reason
category. The category vocabulary belongs to a later fixture/test gate.

## Non-Claims Inside Future Fixtures

Future valid fixture examples must make the boundary explicit where relevant.
Expected non-claims may include:

- `does_not_prove_verification`
- `does_not_prove_trust`
- `does_not_prove_authorization`
- `does_not_prove_transport`
- `does_not_prove_a2a`
- `does_not_prove_connector_enforcement`
- `does_not_prove_marketplace`
- `does_not_prove_agentaction_policy`

The presence of a signature-shaped field must not be treated as proof of trust,
verification, authorization, or exchange.

## Determinism Requirements

A later fixture/test gate must establish that:

- identical signing inputs produce identical expected metadata
- fixture IDs are deterministic
- expected reason categories are stable
- no fixture depends on wall-clock time
- no fixture depends on randomness
- no private key or secret is embedded
- no environment-specific paths or endpoints are embedded
- package nonClaims remain explicit and stable

Production keys, private material, credentials, and tokens are forbidden in all
future repository fixtures.

## Signing and Verification Separation

Signing fixtures must not be used as verification tests. A later verification
scope must independently define:

- trusted key lookup
- signature verification behavior
- revoked or unknown key handling
- invalid signature handling
- verification status vocabulary
- fail-closed trust semantics

Signing fixture results may say that a signing-shaped artifact is structurally
represented. They must not say that the artifact is verified or trusted.

## Allowed Scope For This Gate

Allowed:

- this docs-only fixture scope definition
- future valid and invalid fixture category descriptions
- future expected status/reason category planning
- non-claim and security-boundary definitions
- next-gate sequencing

## Forbidden Scope For This Gate

Forbidden:

- actual fixture JSON files
- private or public key files
- key generation or key management
- signature creation
- signing runtime
- verification runtime
- cryptographic dependencies
- schema or validator changes
- test files
- writer or reader helper changes
- package persistence
- package transport or exchange
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine
- MCP, server, kernel, graph, CLI, UI, or Workbench changes

## Explicit Non-Claims

This scope definition does not mean:

- signing runtime exists
- keys exist or are managed
- signatures are created
- signatures are verified
- packages are trusted
- packages are authorized
- packages are transported or exchanged
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

## Future Sequence

If this scope definition is reviewed and closed cleanly, the safe sequence is:

1. signing fixture creation
2. signing fixture validation tests
3. signing implementation scope or authorization decision
4. narrow signing implementation, only if separately approved
5. signing closeout audit
6. separate verification scope definition

Each step requires its own scope and must preserve the non-claims above.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-signing-1-signing-fixture-scope-definition.md`
- `git diff --check` passes
- no fixture, key, signature, schema, validator, test, or runtime files change
- no signing or verification capability is implemented
- no private material is added
- the document does not claim signing or verification exists
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-SIGNING-2_SIGNATURE_FIXTURES`

That gate, if separately approved, may add only the explicitly scoped signing
fixture files and must not add signing runtime or key material.
