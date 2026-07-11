# V5-VERIFICATION-11 - Trusted-Key Resolver Implementation Scope Definition

**Mode:** Implementation scope definition only
**Current checkpoint:** `V5-VERIFICATION-10_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 1a5f06ecd76742f3a9f7511061a8d05289f0863e`

## Purpose

`V5-VERIFICATION-11` defines the narrow future implementation boundary for a
deterministic, local-only trusted-key resolver. It does not add a resolver,
key store, cryptographic verification, or runtime behavior.

The resolver is a bounded classification step before the existing verification
core:

```txt
bounded resolver input
-> one bounded key-state result
-> existing verification-core input
```

This document authorizes no implementation. A later implementation gate must
be separately approved and must preserve the V7-V10 contract chain.

## Responsibility Boundary

A future resolver may:

- accept a bounded non-secret `keyReference`
- accept fixture-local or otherwise explicitly supplied key-state records
- accept an explicit fixed `evaluationTime`
- select matching records for the supplied reference
- classify the result deterministically
- return only bounded resolver output

A future resolver must not:

- verify signatures or parse signature evidence
- parse certificates or validate certificate chains
- authorize actions or decide package trust
- perform network, database, cache, identity-provider, or live key-store lookup
- generate, import, export, rotate, or manage keys
- change the verification core, writer, reader, MCP surface, or package behavior

## Bounded Input Contract

The future implementation may consume only the minimum bounded concepts
already established by V7-V10:

```txt
{
  keyReference,
  records,
  evaluationTime
}
```

This is a planning shape, not a new schema. The implementation gate must not
publish or introduce a repository schema from this document.

Input requirements:

- `keyReference` is a non-empty bounded identifier and contains no secret or
  operational material.
- `records` is fixture-local or explicitly supplied static metadata, when
  records are needed for the classification.
- `evaluationTime` is supplied by the caller as a valid fixed timestamp.
- Unknown top-level fields, unknown nested fields, arrays in scalar positions,
  malformed objects, and ambiguous records fail closed.
- The input is not mutated.

No input may contain private keys, secrets, credentials, tokens, passwords,
PEM blocks, certificates, JWK material, network endpoints, URLs, provider
responses, database handles, cache handles, or opaque operational state.

## Bounded Output Contract

The future implementation may return only the bounded concepts required by the
existing verification-core boundary:

```txt
{
  keyState,
  reasonCategory
}
```

`keyState` is limited to:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

`reasonCategory` must use the existing verification vocabulary already covered
by the V7-V10 contract. This scope adds no reason category, status, trust
score, authorization result, free-form explanation, key material, or provider
response.

The output must be serializable, deterministic, bounded, and semantically
byte-equivalent for the same bounded input and fixed evaluation time. A
successful resolver result is not a trust or authorization decision.

## Deterministic Evaluation Order

The future implementation must evaluate in this stable fail-closed order:

1. Reject malformed overall input.
2. Reject malformed or missing `keyReference`.
3. Reject unknown or forbidden top-level and nested fields.
4. Recursively reject secret, private-key, key-material, certificate, PEM,
   provider, endpoint, URL, and network metadata, including values inside
   arrays.
5. Reject malformed record structure and invalid scalar types.
6. Resolve matching records only from the supplied bounded records.
7. Reject more than one matching record as ambiguous, even when duplicates are
   identical; no precedence or merge rule is introduced.
8. Return the existing bounded unknown result when there is no matching record.
9. Return the existing bounded unavailable result for an explicitly unavailable
   record.
10. Return the existing bounded revoked result for an explicitly revoked record.
11. Compare expiration metadata only against the supplied fixed
    `evaluationTime` and return the existing expired result when applicable.
12. Return the bounded active result only after every earlier check passes.

The order is part of the future test contract. No failure may fall through to
`active`.

## Normative Expiry Boundary

The resolver must compare parsed timestamp instants, not timestamp strings.
The comparison uses only the explicitly supplied `evaluationTime`:

```txt
expiresAt <= evaluationTime -> expired
expiresAt > evaluationTime  -> eligible for continued active evaluation
```

Therefore, exact equality (`expiresAt == evaluationTime`) resolves to
`expired`. Validity ends at the expiry instant; it does not continue through
that boundary. This rule preserves fail-closed behavior and introduces no new
state, reason category, or output field.

The resolver must not use the system clock, `Date.now()`, an implicit current
time, or a local-time default. Malformed timestamps remain subject to the
existing fail-closed malformed handling.

## Active Result Boundary

`active` is allowed only when all of these conditions hold:

- the overall input is structurally valid
- `keyReference` is bounded and valid
- exactly one matching record exists
- the record contains only approved bounded metadata
- the record explicitly declares `active`
- the record has `expiresAt > evaluationTime` when expiry metadata is present
- no forbidden material or ambiguity exists

The absence of `revoked` does not imply `active`. A missing, unknown,
unavailable, malformed, expired, or ambiguous record must never be promoted to
active by fallback behavior.

## Fixed-Time and Determinism Requirement

The future implementation must require caller-supplied `evaluationTime`.

It must not use:

- the system clock
- `Date.now()`
- implicit current time
- random values
- environment-dependent state
- hidden global state
- network or cache state

The invariant is:

```txt
same bounded input
+ same fixed evaluationTime
-> same keyState and reasonCategory
```

The resolver must not mutate its input or depend on filesystem state outside
the explicitly supplied bounded records.

## Recursive Secret and Network Boundary

The future implementation must reject these fields and their equivalents at
any nesting depth, including inside objects and arrays:

```txt
privateKey
private_key
secret
token
credential
password
keyMaterial
key_material
pem
certificate
jwk
provider
endpoint
networkEndpoint
network_endpoint
url
uri
```

PEM/private-key blocks, provider responses, network configuration, operational
URLs, and opaque key material are also forbidden by value. Public identifier
metadata may be used only when it is bounded structural metadata and cannot be
mistaken for production key material.

## Duplicate Handling

Matching record handling is intentionally narrow:

```txt
zero matching records   -> unknown or another existing bounded result
one valid matching record -> evaluate its bounded state
more than one match     -> malformed / fail closed
```

Identical duplicate records remain ambiguous unless a future, separately
approved contract explicitly changes that rule. The resolver must not invent
merge, precedence, fallback, or last-write-wins behavior.

## Verification-Core Integration Boundary

A future resolver may provide bounded key-state information to the existing
verification core. It must not:

- change verification status or reason vocabulary
- bypass payload, digest, algorithm, or signature-evidence checks
- perform cryptographic verification
- produce signatures
- infer package trust, identity verification, content safety, or authorization
- expose `trusted`, `authorized`, `safe`, or execution-approval output

Resolver classification and signature verification remain separate concerns.

## Planned Implementation Surface

The following are planning references only and must not be created by this
scope-definition PR:

```txt
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver.test.js
```

The future implementation must remain one narrow module with one direct test
surface unless a later scope review explicitly authorizes otherwise.

## Future Gate Sequence

The intended sequence is:

```txt
V5-VERIFICATION-11 implementation scope definition
-> separately authorized implementation taskpack or test scope
-> separately authorized resolver implementation and tests
-> adversarial review
-> resolver closeout audit
-> separately scoped cryptographic adapter work
```

V12 is not authorized by this document. No implementation gate is automatic.

## Stop Conditions

A later task must stop and report if it requires:

- a new key-state or verification reason category
- fixture, schema, validator, verification-core, reader, writer, package, or
  MCP changes
- a second runtime module without explicit scope approval
- network, database, cache, identity-provider, or live key-store integration
- real key material, certificates, cryptographic dependencies, or signature
  handling
- package trust, identity, authorization, or execution decisions
- a change to the fixed-time or fail-closed contract

## Permanent Non-Claims

This scope definition does not mean that any of the following exists:

- a trusted-key resolver implementation
- a live key store, network provider, database resolver, or cache
- certificate-chain validation
- real cryptographic verification
- key generation, rotation, lifecycle, or revocation service
- package trust or authorization decisions
- runtime exchange, transport, or persistence
- A2A, connector enforcement, marketplace, or AgentAction policy engine
- a V5-complete system

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-11-trusted-key-resolver-implementation-scope-definition.md`
- `git diff --check main...HEAD` passes
- V7-V10 states, reason vocabulary, fixture boundaries, and nonClaims remain
  consistent
- no resolver implementation, fixture, test, schema, package, crypto, or
  runtime file changes
- the document makes no implementation-exists or V5-complete claim

## Recommended Next Gate

No next gate is opened automatically. A separately authorized implementation
taskpack or test-scope gate may be considered after this closeout audit.
