# V5-SIGNING-5 - Signing Helper Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-SIGNING-4_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 6c8a83835232414cebecaca1ce1bc97aba84d560`

## Purpose

`V5-SIGNING-5` defines the narrow boundary for a possible future structural
signing helper. It does not implement the helper and does not create a real
signature.

The existing local flow remains unchanged:

`writer -> local candidate -> reader read/shape validation`

The future helper, if separately authorized, would describe signing metadata
for an already validated local candidate. It would not establish trust,
verification, authorization, or package exchange.

## Scope Boundary

A later implementation may be limited to:

- receiving an already validated local candidate
- selecting an explicit canonical payload representation
- validating algorithm and key identifier shape
- returning deterministic structural signing metadata
- preserving package identity and nonClaims
- returning explicit fail-closed reason categories

These are implementation-boundary questions only. This PR does not add code,
change fixtures, or authorize runtime behavior.

## Structural Helper Input

The future helper must receive a local, validated candidate with:

- a supported package/schema version
- a non-empty package identity
- an explicitly defined payload boundary
- a canonicalization version
- an algorithm identifier from an approved vocabulary
- a non-secret key identifier shape

The helper must reject missing, malformed, unsupported, or ambiguous input. It
must not silently select a default algorithm or key.

## Structural Helper Output

The future helper may return only explicitly defined structural metadata, such
as:

- package identity
- canonicalization identifier
- algorithm identifier
- non-secret key identifier
- signing preparation status
- deterministic reason category
- preserved nonClaims

The output must distinguish signing preparation from a cryptographic signature.
Structural metadata must never be described as verified, trusted, authorized,
or exchanged.

## Deterministic Contract

A later implementation and its tests must establish that:

- identical candidates produce identical structural metadata
- canonical payload metadata is stable
- reason categories are deterministic
- fixture IDs and output IDs do not depend on randomness
- wall-clock time is not required for the structural result
- environment paths and network endpoints are not embedded
- package nonClaims are preserved exactly

Any operational timestamp, nonce, or cryptographic output requires a separate
security and implementation decision. It is not part of this scope.

## Fail-Closed Categories

A future helper must fail closed for:

- missing package identity
- missing signing input
- unsupported package/schema version
- missing canonicalization metadata
- missing algorithm identifier
- unsupported algorithm
- missing or malformed key identifier
- malformed signing metadata
- signing claim without an approved structural payload
- verification, trust, or authorization claims
- transport, exchange, A2A, connector, marketplace, or AgentAction claims

Failure output must be deterministic and must not be converted into a trusted
or verified result.

## Key and Crypto Boundary

Key generation and key management are outside this gate. No future helper
implementation under this sequence may introduce:

- private keys
- public key files
- production secrets
- credentials or tokens
- key storage or rotation
- unreviewed crypto dependencies

A key identifier is metadata, not key material. Structural placeholders in
fixtures are not cryptographic signatures.

## Verification Separation

The structural signing helper must not:

- verify a signature
- look up trusted keys
- resolve revocation
- mark an artifact trusted
- mark an artifact authorized
- establish agent or connector trust

Verification requires a separate scope, implementation boundary, result
vocabulary, and fail-closed test chain.

## Allowed Scope For This Gate

Allowed in this docs-only PR:

- structural helper purpose and boundary
- local candidate input requirements
- deterministic output metadata requirements
- fail-closed reason categories
- key and crypto separation rules
- verification separation rules
- future acceptance criteria
- explicit nonClaims and stop conditions

## Forbidden Scope For This Gate

Forbidden in this PR:

- helper implementation
- real signature creation
- cryptographic signing
- key generation or key management
- private/public key material
- crypto dependencies
- verification runtime
- trust or authorization decisions
- schema, validator, fixture, or test changes
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

- a signing helper exists
- a signature is created
- a package is signed
- a signature is verified
- a package is trusted
- a package is authorized
- keys exist or are managed
- crypto dependencies exist
- packages are persisted or exchanged
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

The current writer/reader path remains local and unsigned.

## Future Sequence

If this scope definition is reviewed and closed cleanly, the safe sequence is:

1. separate implementation authorization decision
2. narrow structural helper implementation, if approved
3. helper-specific tests using the existing signing fixtures
4. signing helper closeout audit
5. separate verification scope definition

No step is automatic. Each step must preserve the non-claims above.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-signing-5-signing-helper-scope-definition.md`
- `git diff --check` passes
- no implementation, fixture, test, schema, validator, key, crypto, or
  package files change
- the document does not claim a signing helper exists
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-SIGNING-6_STRUCTURAL_SIGNING_HELPER_IMPLEMENTATION_AUTHORIZATION`

That gate must separately decide whether implementation is justified. It is
not automatic permission to add signing runtime code.
