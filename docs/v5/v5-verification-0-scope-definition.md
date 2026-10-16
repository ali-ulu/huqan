# V5-VERIFICATION-0 - Verification Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `NEXT-GATE-SELECTION_AFTER_V5-SIGNING-6A_CLOSEOUT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 6d6d87211904b7979896218d81bf8358f8b63066`

## Purpose

`V5-VERIFICATION-0` defines the future boundary for evaluating supplied
signature evidence. It does not implement verification, cryptography, trusted
key lookup, or package exchange.

The current local flow remains separate from verification:

`writer -> local candidate -> reader read/shape validation`

The structural signing helper produces structural metadata only. A signing
shaped field is not proof that a signature was created or verified.

## Signing, Verification, Trust, and Authorization

These are separate capabilities:

- **Signing** creates or attaches signing-related structural or cryptographic
  evidence under a separately authorized signing boundary.
- **Verification** evaluates supplied signature evidence against an explicitly
  resolved trusted-key reference and returns a bounded verification result.
- **Trust** is not implied by successful verification.
- **Authorization** is not implied by successful verification.

The following distinctions must remain explicit:

```txt
verified signature != trusted package
verified signature != authorized action
verified signature != safe content
verified signature != approved execution
```

## Future Verification Input Boundary

A later verification gate may define an input containing only explicitly
approved fields, such as:

- the supplied artifact or signature evidence
- the exact canonical payload reference
- signature algorithm identifier
- non-secret key identifier
- an explicitly resolved key reference
- contract/schema version
- provenance and non-claim metadata

The input contract must define whether key resolution is local, injected, or
provided by a separately governed service. Verification must not silently
invent keys, algorithms, trust, or authorization defaults.

The verification boundary must reject or fail closed for:

- missing signature evidence
- missing key reference
- malformed artifact or payload
- unsupported schema or algorithm
- ambiguous key resolution
- revoked or unknown key
- lookup or verification service failure
- trust, authorization, transport, exchange, A2A, connector, marketplace, or
  AgentAction claims outside the verification contract

## Status and Reason Vocabulary

The following status vocabulary is a scope-level candidate for a later fixture
and implementation contract. It is not implemented by this document:

```txt
valid
invalid
unknown_key
revoked_key
unsupported_algorithm
malformed
missing_required_field
verification_unavailable
```

Every later result must include a deterministic reason category that explains
the status without implying trust or authorization. A successful structural
parse must not be reported as `valid` verification unless signature evidence,
key resolution, and the approved verification contract all succeed.

## Fail-Closed Rules

The future verification contract must preserve these rules:

```txt
unknown key      -> not verified
revoked key      -> not verified
missing key      -> not verified
malformed input  -> not verified
unsupported alg  -> not verified
lookup failure   -> not verified
```

Failure results must be deterministic, serializable, and free of claims that
the package is trusted, authorized, safe, or approved for execution.

## Verification and Signing Separation

Verification must not mutate the existing writer or reader helpers. It must
not create signatures, generate or manage keys, or turn structural signing
placeholders into cryptographic evidence.

Signing fixtures must not be treated as verification fixtures. A future
verification fixture gate must independently define:

- valid and invalid evidence categories
- known, unknown, and revoked key cases
- supported and unsupported algorithm cases
- malformed and missing-field cases
- expected status and reason categories
- explicit nonClaims

## Future Sequence

If this scope definition is reviewed and closed cleanly, the safe sequence is:

1. verification fixture scope definition
2. verification fixture creation
3. verification fixture contract tests
4. verification implementation scope definition
5. separately authorized verification helper/runtime implementation
6. permanent implementation contract tests
7. verification closeout audit

No step is automatic. Each step requires its own scope and must preserve the
non-claims below.

## Allowed Scope For This Gate

Allowed in this PR:

- future verification input and output boundary
- candidate status and reason vocabulary
- fail-closed rules
- signing, verification, trust, and authorization separation
- future fixture/test/implementation sequence
- explicit nonClaims and stop conditions

## Forbidden Scope For This Gate

Forbidden in this PR:

- verification runtime implementation
- signature verification or cryptographic operations
- trusted-key lookup implementation
- key generation or key management
- private or public key material
- signing helper changes
- writer or reader helper changes
- schema, validator, fixture, or test changes
- package persistence
- package transport or exchange
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine
- MCP, server, kernel, graph, CLI, UI, or Workbench changes
- package dependency changes

## Explicit Non-Claims

This scope definition does not mean:

- signatures are currently verified
- packages are trusted
- actions are authorized
- content is safe
- execution is approved
- verification runtime exists
- trusted keys are managed
- cryptographic verification exists
- packages are persisted or exchanged
- transport exists
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

The existing writer, reader, and structural signing helper remain local,
bounded, and non-cryptographic.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-0-scope-definition.md`
- `git diff --check` passes
- no verification, crypto, key, signing, schema, validator, fixture, test, or
  package files change
- the document does not claim verification exists
- the document does not claim trust or authorization exists
- the document does not claim V5 is complete

## Recommended Next Gate

`V5-VERIFICATION-1_VERIFICATION_FIXTURE_SCOPE_DEFINITION`

That gate, if separately approved, must remain docs-only and define future
verification fixture categories without adding verification runtime, key
material, or cryptographic dependencies.
