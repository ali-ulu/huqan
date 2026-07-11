# V5-VERIFICATION-5 - Verification Implementation Task-Pack

**Mode:** Task-pack definition only
**Current checkpoint:** `V5-VERIFICATION-4_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 8ea25ddb99cdd9de4fea1332388a40dde09a168b`

## Purpose

`V5-VERIFICATION-5` defines the task-pack for a possible future deterministic
verification decision core. It does not implement verification, cryptography,
trusted-key lookup, or runtime behavior.

The future implementation boundary is:

```txt
bounded verification input
-> deterministic verification decision
-> verificationStatus + reasonCategory
```

The only permitted top-level statuses are:

```txt
verified
not_verified
```

This task-pack does not authorize implementation. The next implementation gate
requires separate approval.

## Authoritative Inputs

The future implementation must use these existing contracts without silently
expanding them:

- `docs/v5/v5-verification-1-verification-fixture-scope-definition.md`
- `docs/v5/v5-verification-4-verification-implementation-scope-definition.md`
- the 15 JSON fixtures under `test/fixtures/v5/verification/`
- `test/v5-verification-fixtures.test.js`
- the existing local writer, reader, and structural signing boundaries

The fixture corpus and its existing reason vocabulary are authoritative.
Fixture fields must not be changed to fit a future implementation.

## Narrow Implementation Surface

After separate approval, the implementation PR may contain at most:

```txt
one verification implementation module
one direct implementation contract/adversarial test file
reuse of the existing 15 fixtures and fixture contract tests
```

The exact filenames must be confirmed by a repository convention audit in that
future implementation task. This task-pack creates none of those files.

No new schema, validator, helper, package export, or dependency is required by
this task-pack.

## Input Contract

The future implementation may accept only the bounded inputs already defined
by Verification-1, Verification-4, and the fixtures:

- canonical payload metadata
- payload digest
- algorithm identifier
- signature evidence
- non-secret key reference
- previously resolved bounded key-state result
- fixed evaluation time
- explicit nonClaims where applicable

No new field, status, resolver state, algorithm, or trust default may be
invented.

The bounded resolved key state may be one of:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

The implementation consumes this state. It does not perform key lookup.

## Output Contract

Every result must have exactly the two semantic dimensions:

```txt
verificationStatus
reasonCategory
```

The existing reason vocabulary must be preserved exactly:

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

No new reason category may be introduced by the implementation task-pack.

## Fail-Closed Evaluation Order

The future implementation must define and test a deterministic evaluation
order consistent with the current fixtures:

1. reject malformed or missing input
2. reject forbidden trust, authorization, and exchange claims
3. check supported algorithm
4. check payload identity
5. check payload digest match
6. classify the supplied resolved key state
7. evaluate the bounded signature evidence
8. return the final status and reason category

The exact precedence must not convert an invalid or unsupported input into a
`verified` result. Any conflict with the existing fixture mapping is a stop
condition.

## Determinism Contract

The required invariant is:

```txt
same canonical input
+ same resolved key state
+ same fixed evaluation time
-> same verificationStatus
+ same reasonCategory
```

The implementation and its tests must not depend on:

- system time
- network state
- hidden global state
- randomness
- generated identifiers
- environment paths or hostnames

Inputs must not be mutated. Results must be serializable and deterministic.

## Required Test Plan For The Future Implementation PR

The separately authorized implementation PR must at minimum prove:

- exact mapping for all 15 fixtures
- repeated evaluation determinism
- unknown, revoked, expired, and unavailable key-state handling
- malformed input fail-closed behavior
- forbidden trust, authorization, and exchange claim handling
- no network access
- no system-clock dependency
- no secret material
- no package trust or authorization output

These tests must exercise the implementation directly. They must not create a
fake verifier or alter the existing fixture contract.

## Resolver Boundary

Trusted-key resolver remains a separate gate. The future implementation must
not:

- search for keys
- call a network service
- read a database or key store
- manage a key registry
- implement cache or rotation policy
- validate a certificate chain
- integrate with an identity provider

The verifier consumes only the bounded/resolved key state supplied to it.

## Crypto Boundary

This task-pack separates two future stages:

```txt
A. deterministic verification decision core
B. separately authorized cryptographic adapter
```

This task-pack prepares only stage A. It does not make real cryptography,
signature generation, or cryptographic signature verification mandatory.

The following remain forbidden until separately authorized:

- crypto imports
- real algorithm implementation
- public or private key material
- certificate material
- signature generation
- cryptographic verification code

Synthetic signature-shaped values remain fixture contract data only.

## Forbidden Scope

The future implementation task must stop rather than expand into:

- trusted-key resolver
- real key store or registry
- certificate lifecycle
- package trust engine
- authorization engine
- connector enforcement
- A2A exchange
- marketplace behavior
- UI or Workbench
- MCP surface changes
- runtime writer or reader changes
- package persistence or transport
- schema, validator, fixture, or dependency changes
- V5 complete claim

## Stop Conditions

The implementation must not start or must stop if any of these occurs:

- fixture contract contradiction
- need for a new schema
- need for a resolver
- need for a crypto dependency
- need for multiple runtime modules
- need to change the existing reader/writer contract
- need to expand the reason vocabulary
- need for key storage, network access, or certificate lifecycle
- need for package trust or action authorization
- any secret or real cryptographic material

## Non-Claims

Closing this task-pack does not mean:

- verification runtime exists
- cryptographic verification exists
- a trusted-key resolver exists
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

The staged sequence is:

```txt
V5-VERIFICATION-5
verification implementation task-pack

-> V5-VERIFICATION-6
verification implementation

-> permanent/adversarial tests

-> verification closeout audit
```

No later stage is started or authorized by this document.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-5-verification-implementation-taskpack.md`
- `git diff --check` passes
- no runtime, crypto, resolver, schema, fixture, test, or package files change
- the existing 15-fixture contract remains authoritative
- no implementation file is added
- the document does not claim V5 is complete

## Verification Profile

```txt
Runtime: docs-only
Tests not run: docs-only scope.
```

## Recommended Next Gate

`V5-VERIFICATION-6_VERIFICATION_IMPLEMENTATION`

That gate requires separate explicit implementation authorization. This
task-pack is not automatic permission to add verification runtime or
cryptographic behavior.
