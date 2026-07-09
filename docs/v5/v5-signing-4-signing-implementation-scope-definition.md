# V5-SIGNING-4 - Signing Implementation Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-SIGNING-3_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 7a76f8aafd2732a20c170cf8d95441ddcd48b5b1`

## Purpose

`V5-SIGNING-4` defines the narrow boundary for a possible future signing
implementation. It does not implement signing, create keys, create signatures,
or authorize package exchange.

The current local flow remains unchanged:

`writer -> local candidate -> reader read/shape validation`

The signing fixture corpus and tests are structural contract evidence only.
They do not establish a signing capability.

## Scope Boundary

A separately approved implementation may eventually:

- accept an already validated local package candidate
- canonicalize an explicitly defined signing payload
- apply an approved signing operation through an isolated helper
- return deterministic signing-shaped metadata
- preserve package identity and explicit nonClaims
- fail closed for unsupported or malformed signing inputs

This document does not authorize that implementation. It only defines the
questions and constraints that a later implementation task must satisfy.

## Candidate Input Contract

A future signing helper must receive a validated local candidate, not an
untrusted transport payload. The future input boundary must define:

- supported package/schema version
- package identity and payload identity
- canonical serialization version
- key identifier metadata
- supported algorithm identifier
- explicit signing mode
- deterministic error behavior

The helper must reject missing, malformed, unsupported, or ambiguous input
instead of silently inventing defaults.

## Candidate Output Contract

A future signing helper may return a signing-shaped artifact containing only
explicitly approved metadata, such as:

- source package identity
- canonicalization identifier
- algorithm identifier
- non-secret key identifier
- structural signature metadata
- deterministic status and reason category
- preserved nonClaims

The output must clearly distinguish unsigned, signing-prepared, and signed
states. A signing result must not be presented as verified, trusted, or
authorized.

## Determinism Requirements

Any later implementation and its tests must prove that:

- identical inputs produce identical canonical payload metadata
- output field ordering or canonical serialization is stable
- IDs and reason categories are deterministic
- wall-clock time is not required for the structural result
- randomness is not required for the deterministic contract result
- environment paths and endpoints are not embedded
- package nonClaims are preserved exactly

If an operational timestamp or cryptographic nonce is later required, that is
a separate design decision and must not weaken the deterministic test contract.

## Key Material Boundary

Key generation and key management are outside this scope. In particular, a
future implementation task must not introduce private keys, credentials,
production secrets, or unreviewed key storage.

Any key access needed by a later implementation requires a separate security
decision covering:

- ownership and workspace binding
- secret storage and access control
- rotation and revocation
- algorithm lifecycle
- redaction and audit behavior
- test-key versus production-key separation

Fixture placeholders and key identifiers are not key material.

## Signing and Verification Separation

Signing and verification are separate capabilities. A future signing helper
must not:

- look up trusted keys
- decide whether a signature is valid
- mark a package as trusted
- mark a package as authorized
- resolve revocation status
- establish an agent-to-agent trust relationship

Verification requires its own scope, inputs, result vocabulary, trust policy,
and fail-closed tests. Signing output alone never proves verification, trust,
or authorization.

## Failure and Stop Conditions

A later implementation task must stop or return a deterministic failure for:

- missing package identity
- missing signing input
- missing key identifier
- missing algorithm identifier
- unsupported algorithm
- malformed signing metadata
- signature-shaped claim without approved data
- verification, trust, or authorization claim in a signing-only result
- transport, exchange, A2A, connector, marketplace, or AgentAction claim
- unsupported schema or contract version

No failure path may silently downgrade into a trusted or verified result.

## Allowed Scope For This Gate

Allowed in this PR:

- this docs-only implementation boundary
- future input and output contract questions
- deterministic behavior requirements
- key material and security boundary definitions
- signing/verification separation
- future implementation acceptance criteria
- non-claims and stop conditions

## Forbidden Scope For This Gate

Forbidden in this PR:

- signing runtime implementation
- key generation or key management
- private or public key files
- production secrets or credentials
- signature creation
- signature verification runtime
- cryptographic dependencies
- schema or validator changes
- fixture or test changes
- writer or reader helper changes
- package persistence
- package transport or exchange
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine
- MCP, server, kernel, graph, CLI, UI, or Workbench changes

## Explicit Non-Claims

Closing this scope definition does not mean:

- signing runtime exists
- keys exist or are managed
- signatures are created
- signatures are verified
- packages are trusted
- packages are authorized
- packages are persisted or transported
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

The existing writer/reader flow remains local and unsigned.

## Future Sequence

If this scope definition is reviewed and closed cleanly, the safe sequence is:

1. implementation authorization or task-pack review
2. narrow signing helper implementation
3. implementation-specific tests using the existing structural fixtures
4. signing closeout audit
5. separate verification scope definition
6. separate transport or exchange scope, if ever authorized

Each step requires its own approval and must preserve the non-claims above.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-signing-4-signing-implementation-scope-definition.md`
- `git diff --check` passes
- no runtime, key, signature, crypto, schema, validator, fixture, test, or
  package files change
- the document does not claim signing or verification capability exists
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-SIGNING-4_IMPLEMENTATION_AUTHORIZATION_DECISION`

That gate must decide separately whether a narrow signing implementation is
justified. It must not be treated as automatic permission to write runtime
code.
