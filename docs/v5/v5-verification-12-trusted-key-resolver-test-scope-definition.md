# V5-VERIFICATION-12 - Trusted-Key Resolver Test Scope Definition

**Mode:** Test scope definition only
**Current checkpoint:** `V5-VERIFICATION-11A_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ e3bc5f1453105ad282839cd32aa00c8045bcbd26`

## Purpose

`V5-VERIFICATION-12` defines the future executable test contract for the
bounded deterministic trusted-key resolver described by V7-V11A. This PR is
docs-only. It authorizes neither test code nor resolver implementation.

The planned future surfaces are references only:

```txt
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver.test.js
```

Neither file is created by this scope-definition PR.

## Contract Source Hierarchy

The future test suite must derive behavior only from these canonical sources:

1. V7 trusted-key resolver scope definition
2. V8 trusted-key resolver fixture scope definition
3. V9 trusted-key resolver fixture corpus
4. V10 trusted-key resolver fixture contract tests
5. V11 trusted-key resolver implementation scope definition
6. V11A expiry equality contract amendment

Tests must not invent a new key-state, reason category, output field,
precedence rule, duplicate policy, or timestamp interpretation.

## System Under Test

The future test suite will exercise only the planned bounded resolver surface.
It will not create that surface in this gate.

The suite must prove only:

- bounded resolver input validation
- deterministic record selection
- fixed-time state evaluation
- fail-closed handling
- bounded resolver output
- compatibility of bounded resolver output with the existing verification-core
  boundary, without bypassing verification-core checks

It must not test or imply cryptographic verification, certificate validation,
live key stores, network or database providers, package trust, or action
authorization.

## Positive Path

Exactly one bounded positive path is specified:

- structurally valid input
- valid bounded `keyReference`
- exactly one matching record
- no forbidden material
- record explicitly declares `active`
- explicit valid `evaluationTime`
- when expiry metadata exists, `expiresAt > evaluationTime`
- bounded deterministic active output

Absence of revocation alone must never produce `active`. The future test must
assert that active is reached only after every earlier fail-closed condition
passes.

## Canonical Fail-Closed Evaluation Matrix

The future test suite must preserve the exact V11 evaluation order:

1. malformed overall input
2. malformed `keyReference`
3. unknown or forbidden top-level field
4. recursively nested secret, private-key, or key-material field
5. recursively nested network or provider metadata
6. malformed record structure
7. ambiguous duplicate matching records
8. no matching record
9. unavailable record
10. revoked record
11. expired record evaluated against explicit `evaluationTime`
12. bounded active record

The test scope must keep this order stable and testable. A failure at an
earlier stage must not fall through to a later successful state.

## Expiry Equality Boundary

The V11A amendment is normative for the future tests:

```txt
expiresAt < evaluationTime -> expired
expiresAt == evaluationTime -> expired
expiresAt > evaluationTime -> may continue toward active evaluation
```

Tests must compare parsed timestamp instants, not timestamp strings. They must
use an explicit fixed `evaluationTime` and must cover the equality boundary.

Malformed timestamps must remain fail-closed. The suite must not use the
system clock, `Date.now()`, an implicit current time, or a local-time default.

## Fixture Integration

The future tests must consume all 12 existing fixtures under:

```txt
test/fixtures/v5/trusted-key-resolver/
```

The test suite must:

- account for all 12 fixture files
- parse the existing files rather than duplicate their data
- avoid mutating fixture files or loaded fixture objects
- preserve the existing state and reason vocabulary
- map every fixture to at least one explicit assertion
- use stable sorted fixture discovery
- ensure discovery order cannot change results

No fixture may be rewritten, extended, or replaced by test-only data.

## Required Fixture Mapping

The 12 existing fixtures must remain represented by these contract groups:

```txt
01 active bounded record                 -> active only when unexpired
02 unknown key reference                 -> unknown
03 revoked key reference                -> revoked
04 expired metadata boundary            -> expired
05 unavailable lookup state             -> unavailable
06 malformed key reference              -> malformed
07 unknown top-level metadata           -> malformed
08 nested secret/private-key material   -> malformed
09 nested network/provider metadata     -> malformed
10 unsafe key-material alias            -> malformed
11 ambiguous duplicate records          -> malformed
12 deterministic repeat                -> same bounded active result
```

The mapping is descriptive of the existing corpus and does not introduce a
new fixture vocabulary.

## Determinism and Immutability

The future tests must prove:

- same bounded input plus same `evaluationTime` produces deep-equal semantic
  output
- repeated execution produces the same result
- fixture discovery order does not affect the result
- input objects are not mutated
- record arrays are not reordered
- fixture objects are not mutated
- no randomness is used
- no environment-variable dependency exists
- no network, database, or hidden global state is used
- no hidden mutable cache affects output
- test order does not affect output

Each test must create a fresh input when mutation or boundary behavior is
being checked.

## Duplicate Handling

The future tests must prove the existing bounded policy:

```txt
zero matching records       -> existing bounded unknown result
one matching record         -> evaluate its bounded state
multiple matching records   -> fail closed
identical duplicates        -> remain ambiguous
```

Input order must not create precedence. The future implementation and tests
must not use first-write-wins, last-write-wins, merge, fallback, or implicit
precedence behavior.

## Recursive Forbidden-Material Coverage

The future test scope must include nested object and array cases for the
canonical V11 concepts:

```txt
privateKey
secret
token
credential
password
keyMaterial
private-key or PEM material
provider
endpoint
URL
network configuration
```

Coverage must be recursive and must include equivalent nested forms already
authorized by V11. This scope must not broaden the canonical vocabulary.

Every forbidden-material case must remain fail-closed and must never produce
the bounded active result.

## Output Assertions

Future tests must assert exact bounded output fields only:

```txt
keyState
reasonCategory
```

They must reject or fail the contract if output contains:

- free-form explanation
- trust score
- authorization verdict
- private material
- operational provider metadata
- network metadata
- unspecified additional output fields

This document defines no new schema.

## Verification-Core Boundary

Future tests may verify that bounded resolver output can be handed to the
existing verification-core boundary where that compatibility is meaningful.
They must not:

- modify `lib/v5/verification-core.js`
- bypass algorithm checks
- bypass payload or digest identity checks
- bypass signature-evidence checks
- perform real cryptographic verification
- produce package trust output
- produce authorization decisions

Resolver classification and signature verification remain separate contracts.

## Test Groups

The future implementation test scope should contain independent groups for:

- API and input validation
- deterministic record selection
- key-state evaluation
- expiry equality boundary
- fixed-time behavior
- recursive forbidden-material rejection
- duplicate ambiguity
- determinism
- immutability
- fixture corpus conformance
- verification-core handoff boundary
- permanent non-claims

No artificial pass count is prescribed. Coverage must be driven by the
contract and the existing fixture corpus.

## Test Isolation

Each future test must be independent:

- use fresh input per mutation-sensitive test
- avoid shared mutable fixture objects
- avoid execution-order dependencies
- write no persistent output files
- use no network
- use no database
- do not mutate environment variables
- use no cleanup-sensitive global state

The suite must be safe to run repeatedly in a clean checkout.

## Future Sequence

This document records only the following sequence:

```txt
V12 test scope definition
-> separately authorized test implementation or taskpack
-> separately authorized resolver implementation
-> adversarial review
-> implementation closeout
-> later separate cryptographic-adapter scope
```

V13 is not authorized or started by this document.

## Permanent Non-Claims

This scope definition does not mean that any of the following exists:

- trusted-key resolver implementation
- trusted-key resolver test implementation
- real cryptographic verification
- certificate validation
- live key store
- network or database resolver provider
- key generation or rotation
- revocation service
- package trust decision
- authorization decision
- A2A or connector enforcement
- runtime exchange, transport, or persistence
- a V5-complete system

## Forbidden Scope

This docs-only PR must not contain:

- resolver implementation
- test implementation
- fixture changes
- verification-core changes
- schema or validator changes
- package or dependency changes
- crypto or certificate parsing
- runtime or MCP changes
- network, database, or key-store integration
- trust or authorization output
- broad staging

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-12-trusted-key-resolver-test-scope-definition.md`
- `git diff --check main...HEAD` passes
- V7-V11A contracts remain consistent
- all 12 existing fixtures are accounted for
- the expiry equality rule remains `expired`
- no test or resolver code is created
- no fixture, schema, package, runtime, crypto, network, or MCP file changes
- the document makes no trust, authorization, or V5-complete claim

## Recommended Next Gate

No next gate is opened automatically. A separately authorized test
implementation or taskpack gate may be considered after this closeout audit.
