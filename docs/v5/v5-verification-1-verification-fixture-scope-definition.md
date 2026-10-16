# V5-VERIFICATION-1 - Verification Fixture Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `V5-VERIFICATION-0_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 2c59a7cc5e5ac3be0acc26f7492015d20bb57b16`

## Purpose

`V5-VERIFICATION-1` defines the future fixture families for bounded signature
verification evidence. It does not add fixtures, tests, schemas, validators,
helpers, cryptography, trusted-key lookup, or runtime behavior.

The current local capability remains:

```txt
local package construction
local package read/shape validation
bounded structural signing preparation
```

This gate does not make HUQAN a verifier of signed external packages.

## Mandatory Semantic Separation

The future fixture contract must keep these concepts separate:

```txt
structural package validity
!= signature verification
!= Agent Identity lifecycle state
!= provenance matching
!= replay verification
!= package trust
!= action authorization
```

The following statements must remain true:

```txt
A valid signature does not establish package trust.
A verified signature does not authorize an action.
An active identity does not prove signature validity.
Structural readability does not prove authenticity.
```

Verification fixtures must not combine these meanings into one overloaded
status field.

## Future Fixture Input Boundary

Future fixtures may contain only bounded synthetic representations of:

- a supported algorithm identifier
- canonical payload metadata
- a deterministic payload digest
- signature-shaped placeholder test data
- a non-secret key identifier or reference
- bounded trusted-key metadata reference
- key lifecycle metadata needed for test classification
- explicit `nonClaims`

All fixture values must be synthetic and non-secret. A signature-shaped
placeholder is not a production signature. A trusted-key metadata reference
does not mean a resolver or live trust store exists.

No fixture may require external network access or mutable runtime state.

## Required Fixture Families

### Positive Bounded Case

The future corpus must include a structural success-shaped case containing:

- supported algorithm
- canonical payload metadata
- matching payload digest
- structurally present signature evidence
- non-secret key reference
- trusted-key metadata marked active
- no forbidden trust or authorization claim

This represents only an expected signature-verification-shaped success case. It
does not establish package trust or action authorization.

### Negative Cases

The future corpus must cover:

- missing signature evidence
- malformed signature evidence
- payload digest mismatch
- unsupported algorithm
- unknown key
- revoked key
- expired key metadata
- key lookup unavailable
- malformed trusted-key record
- signing/verification payload identity mismatch
- embedded trust claim
- embedded authorization claim
- embedded exchange or transport claim

The corpus must also include a deterministic repeated-evaluation case:

```txt
same bounded input
-> same expected verification_status
-> same expected reason_category
```

## Result Model

Fixtures must separate outcome from explanation:

```txt
verification_status
reason_category
```

The minimal top-level status vocabulary is:

```txt
verified
not_verified
```

Reason categories must be deterministic and more specific than the top-level
status. The future vocabulary must include:

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

The vocabulary is a fixture contract only. It is not implementation code.

## Forbidden Fixture Outcomes

Future fixtures must never produce or claim any of these outcomes:

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

Signature verification is one bounded evidence result, not a global trust
verdict.

## Forbidden Fixture Material

Future fixtures must not contain:

- a real private key
- a real public key body
- a real certificate
- a real production signature
- secret material
- credentials
- crypto dependencies
- key-generation output
- network endpoints
- live key lookup
- filesystem or database persistence
- key rotation implementation
- certificate-chain implementation

Fixtures must not depend on system time unless a fixed test timestamp is part
of the explicitly defined fixture contract.

## Trusted-Key Resolver Boundary

```txt
Trusted-key lookup/resolver is a separate future scope.
```

Verification-1 may define synthetic resolver outcomes needed by future
fixtures:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

This gate must not define or implement:

- resolver storage
- network protocol
- cache policy
- key rotation policy
- certificate authority model
- identity-provider integration
- trusted-key resolver implementation

Real cryptography and trusted-key lifecycle must remain separate future risk
surfaces.

## Non-Claims

This scope definition does not mean:

- real cryptographic signature verification exists
- a trusted-key resolver exists
- a package trust decision exists
- action authorization exists
- external package exchange exists
- connector enforcement exists
- A2A trust exchange exists
- certificate validation exists
- a production key lifecycle exists

The safe current capability statement is:

```txt
HUQAN can deterministically construct and inspect local Shared Trust Packages
and prepare bounded structural signing metadata while preserving explicit
non-claims.
```

The following claims remain forbidden:

```txt
HUQAN verifies signed external packages.
HUQAN establishes package trust.
HUQAN authorizes exchanged actions.
HUQAN operates a trusted-key infrastructure.
HUQAN provides a production cryptographic trust network.
```

## Required Roadmap Sequence

The narrow sequence is:

```txt
V5-VERIFICATION-1
Verification Fixture Scope Definition

-> V5-VERIFICATION-2
Verification Fixtures

-> V5-VERIFICATION-3
Verification Fixture Contract Tests

-> V5-VERIFICATION-4
Verification Implementation Scope

-> separate Trusted-Key Resolver Scope

-> separately authorized narrow verification implementation

-> permanent implementation/adversarial tests

-> verification closeout audit
```

No later gate is started by this document.

## Allowed Scope For This Gate

Allowed in this PR:

- future verification fixture families
- bounded synthetic input categories
- deterministic status and reason vocabulary
- semantic separation rules
- trusted-key resolver boundary
- non-claims and stop conditions
- the future fixture/test/implementation sequence

## Forbidden Scope For This Gate

Forbidden in this PR:

- verification fixture files
- verification tests
- verification schema or validator
- verification helper or runtime
- cryptographic verifier
- trusted-key resolver or key registry
- key persistence or network lookup
- signing helper changes
- writer or reader helper changes
- package export/import
- connector integration
- A2A exchange
- package, schema, dependency, or runtime changes
- MCP, server, kernel, graph, CLI, UI, or Workbench changes

## Definition Of Done

This docs-only PR may close only if:

- exactly one documentation file is added
- zero runtime files change
- zero fixture files are added
- zero test files change
- zero schema files change
- zero dependency files change
- semantic verification boundaries are explicit
- fixture families are explicit
- status and reason dimensions are separate
- trusted-key resolver remains separate
- crypto remains absent
- trust and authorization non-claims are explicit
- the roadmap sequence is recorded
- `git diff --check` passes

## Verification Profile

```txt
Runtime: docs-only
```

Required checks for this PR:

```bash
git diff --check
git diff --name-only main...HEAD
git status --short
```

Tests not run: docs-only scope; no runtime, schema, fixture, test or package changes.

## Recommended Next Gate

`V5-VERIFICATION-2_VERIFICATION_FIXTURES`

That gate, if separately approved, may add only the explicitly scoped
synthetic fixture files. It must not add verification tests, schemas,
validators, helpers, resolvers, crypto, key material, or runtime behavior.
