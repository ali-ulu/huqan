# V5-SIGNING-0 - Shared Trust Package Signing Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-3I_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ ad9565c090091f65531a6456298091b2b1973211`

## Purpose

`V5-SIGNING-0` defines the future boundary for signing Shared Trust Package
artifacts. It does not implement signing, create keys, or authorize package
exchange.

The current writer and reader helpers remain local and unsigned:

`writer -> local candidate -> reader read/shape validation`

Signing is a separate future capability and must not be inferred from that
local flow.

## Source Basis

The current V5 contract chain provides:

- machine-readable package shape
- validator and conformance boundaries
- runtime writer helper
- runtime reader helper
- local writer/reader contract test

Existing writer and reader claim guards reject signing or verification claims.
This scope definition creates the next planning boundary without changing those
helpers or their tests.

## Signing Boundary

A later signing gate may define how a package candidate is transformed into a
signed artifact. That later gate must define, at minimum:

- the exact signed payload boundary
- canonical serialization rules
- algorithm and key metadata vocabulary
- signature field placement
- key identifier representation
- unsigned and signed status distinction
- invalid signature and unsupported algorithm categories
- deterministic error behavior
- separation from verification responsibilities

These are planning questions only in `V5-SIGNING-0`. No answer here creates a
cryptographic capability.

## Candidate Future Flow

The future signing sequence may be considered as separate stages:

1. Receive an already validated local package candidate.
2. Canonicalize the exact payload to be signed.
3. Apply a separately authorized signing operation.
4. Return a signed artifact with explicit signature metadata.
5. Leave verification to a separate verification gate.

This document does not authorize any of those operations. In particular, the
local writer/reader handoff is not a signed envelope and is not an exchange
protocol.

## Future Fixture and Test Questions

Separate future gates may define fixtures and tests for:

- unsigned package candidate
- valid signed artifact with deterministic metadata
- missing signature metadata
- unsupported signing algorithm
- malformed signature encoding
- mismatched key identifier
- signature claim without a signature payload
- signing claim while signing capability is unavailable
- preservation of package non-claims through signing preparation

No fixture, schema, validator, test, key, or signed artifact is added by this
scope-definition gate.

## Key Management Boundary

Key management requires its own explicit design and security review. It is not
part of this gate. Future work must separately decide:

- key ownership and workspace binding
- key storage and access control
- rotation and revocation
- algorithm lifecycle
- secret handling and redaction
- test-key versus production-key separation

No private key generation, loading, storage, rotation, or distribution is
permitted here.

## Verification Separation

Signing and verification are different capabilities. This gate does not define
verification runtime and must not use words such as `verified`, `trusted`, or
`authorized` as a result of signing.

A later verification scope must independently define:

- signature verification inputs
- trusted key lookup policy
- invalid or revoked key behavior
- verification result vocabulary
- fail-closed behavior

Signing alone must never establish trust or authorization.

## Allowed Scope For This Gate

Allowed:

- this docs-only signing boundary definition
- future signing fixture categories
- future signing test questions
- separation of signing, verification, transport, and trust concerns
- non-claim and stop-condition definitions
- a future gate sequence recommendation

## Forbidden Scope For This Gate

Forbidden:

- signing runtime implementation
- cryptographic key generation or loading
- private-key storage
- signature creation
- signature verification runtime
- package persistence
- package transport or exchange
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine
- writer or reader helper changes
- schema, validator, fixture, or test changes
- package dependency changes
- MCP, server, kernel, graph, CLI, UI, or Workbench changes

## Explicit Non-Claims

This scope definition does not mean:

- packages are signed
- signatures are verified
- keys exist or are managed
- packages are cryptographically trusted
- signing establishes authorization
- packages are transported or exchanged
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

The existing local writer/reader contract remains unsigned and local.

## Future Sequence

If this scope definition is reviewed and closed cleanly, a safe future sequence
is:

1. signing fixture scope definition
2. signing fixture creation
3. signing test scope and tests
4. narrowly authorized signing implementation
5. signing closeout audit
6. separate verification scope definition

Each step requires its own scope and must preserve the non-claims above.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is `docs/v5/v5-signing-0-scope-definition.md`
- `git diff --check` passes
- no signing or verification code is added
- no keys, fixtures, schemas, validators, or tests are added
- no writer or reader helper changes
- no package, persistence, transport, or exchange behavior changes
- the document does not claim signing or verification exists
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-SIGNING-1_FIXTURE_SCOPE_DEFINITION`

That gate, if separately approved, must remain docs-only and define future
signing fixture categories without creating keys, signatures, or runtime
behavior.
