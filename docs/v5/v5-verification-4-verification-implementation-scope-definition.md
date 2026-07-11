# V5-VERIFICATION-4 - Verification Implementation Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-VERIFICATION-3_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ f64b5137c8ef820ab7df5d6d1e631d56e5e0f14a`

## Purpose

`V5-VERIFICATION-4` defines the boundary for a possible future bounded
verification implementation. It does not implement verification, cryptography,
trusted-key lookup, or runtime behavior.

The future flow is limited to:

```txt
bounded verification input
-> deterministic signature verification result
-> verificationStatus + reasonCategory
```

The only top-level result statuses are:

```txt
verified
not_verified
```

This document does not authorize the implementation. A separate task-pack and
implementation approval are required.

## Input Boundary

A future implementation may accept only the bounded fields established by
Verification-1 and the 15 merged fixtures:

- canonical payload representation
- payload digest
- algorithm identifier
- signature evidence
- non-secret key reference
- previously resolved bounded key-state result
- fixed evaluation time
- explicit nonClaims where applicable

The implementation must not invent fields, defaults, key states, algorithms,
or trust decisions that are not present in the approved contract.

The bounded key-state input may represent only these resolver outcomes:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

The verifier consumes this resolved state. It does not resolve the key itself.

## Resolver Separation

Trusted-key lookup/resolver is a separate future scope. This implementation
must not:

- search for keys
- call a network service
- read a database or key store
- manage a key registry
- run a certificate authority
- rotate keys
- integrate with an identity provider
- apply cache or revocation policies

The verifier receives a bounded/resolved key state and evaluates the supplied
evidence against that state.

## Crypto Separation

Real cryptographic implementation requires a separate security and
authorization decision. This scope definition does not add it.

Forbidden in this gate and any future implementation covered by this narrow
boundary until separately authorized:

```txt
crypto imports
algorithm implementation
public/private key material
certificate material
signature generation
cryptographic signature verification code
```

Synthetic signature-shaped fixture data remains contract data, not a real
signature.

## Result and Failure Contract

The implementation must preserve the two-dimensional result model:

```txt
verificationStatus
reasonCategory
```

It must use only the existing reason categories:

```txt
signature_valid
missing_signature_evidence
malformed_signature_evidence
payload_digest_mismatch
unsupported_algorithm
unknown_key
revoked_key
expired_key_metadata
key_lookup_unavailable
malformed_trusted_key_record
payload_identity_mismatch
forbidden_trust_claim
forbidden_authorization_claim
forbidden_exchange_claim
```

No new reason category may be introduced by the implementation scope.

The implementation must fail closed for missing, malformed, unsupported,
unknown, revoked, expired, unavailable, or forbidden-claim inputs. No failure
may become `verified` through a silent fallback.

## Determinism

The required invariant is:

```txt
same canonical input
+ same resolved key state
+ same fixed evaluation time
-> same verificationStatus
+ same reasonCategory
```

The implementation must not depend on:

- the system clock
- network state
- hidden global state
- random values
- generated identifiers
- environment paths or hostnames

Inputs must not be mutated. Results must be deterministic and serializable.

## Semantic Non-Equivalence

Verification is a bounded evidence result and must remain separate from:

```txt
signature verification != package trust
signature verification != action authorization
signature verification != identity verification
signature verification != provenance verification
signature verification != external exchange approval
```

A `verified` result must not be represented as:

```txt
trusted
authorized
safe
approved
approved_for_execution
identity_verified
provenance_verified
exchange_verified
certified
production_ready
```

## Future Implementation Surface

After a separately approved task-pack, the narrow implementation PR may
propose at most:

```txt
one verification implementation module
one direct contract/adversarial test file
reuse of the existing fixture contract tests and fixture corpus
```

The exact filenames must be confirmed by a repository audit in that future
task-pack. This scope-definition PR creates none of those files.

## Out Of Scope

The following remain separate future work:

- trusted-key resolver
- key storage or registry
- certificate lifecycle or chain validation
- package trust engine
- authorization engine
- connector enforcement
- A2A exchange
- marketplace behavior
- UI or Workbench changes
- MCP surface changes
- runtime writer or reader changes
- package persistence or transport
- schema, validator, fixture, or dependency changes

## Explicit Non-Claims

This scope definition does not mean:

- verification runtime exists
- cryptographic verification exists
- trusted-key resolver exists
- packages are trusted
- actions are authorized
- identity is verified
- provenance is verified
- external exchange is approved
- connector enforcement exists
- A2A trust exchange exists
- certificate-chain validation exists
- V5 is complete

## Required Sequence

The safe sequence remains:

```txt
V5-VERIFICATION-4
verification implementation scope definition

-> V5-VERIFICATION-5
verification implementation task-pack

-> separately authorized narrow implementation

-> permanent/adversarial implementation tests

-> verification closeout audit
```

No later stage is started or authorized by this document.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-4-verification-implementation-scope-definition.md`
- `git diff --check` passes
- no runtime, crypto, resolver, schema, fixture, test, or package files change
- no implementation file is added
- the document preserves the existing status and reason vocabulary
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-VERIFICATION-5_VERIFICATION_IMPLEMENTATION_TASKPACK`

That gate must remain a separate decision/task-pack gate. It is not automatic
permission to implement verification runtime or cryptographic behavior.
