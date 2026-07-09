# V5-IMPL-3B - Runtime Reader Fixture Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-3A_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ cc7d0e874a0cffe795cd4ed9a5b30fd138d9e19a`

## Purpose

`V5-IMPL-3B` defines the future fixture coverage boundary for a Shared Trust
Package runtime reader.

This document does not add fixture files. It only defines which future reader
fixtures should exist, what each fixture category should prove, and which
non-claims must remain locked before any actual reader fixture PR can be opened.

## Source Basis

The reader chain starts from the sealed 3A scope boundary:

- `V5-IMPL-3A` defined the runtime reader scope as docs-only.
- `V5-IMPL-3A_CLOSEOUT_AUDIT_GREEN` sealed that the reader remains future
  scope only.
- `V5-IMPL-3B` is the next docs-only step: define future reader fixture
  categories before adding fixture JSON files.

This document does not authorize fixture implementation by itself.

## Current Runtime Status

At this checkpoint:

- runtime writer helper exists
- runtime reader is not implemented
- runtime reader fixtures are not added
- runtime reader tests are not added
- runtime exchange is not implemented
- signing runtime is not implemented
- verification runtime is not implemented
- A2A transport is not implemented
- connector enforcement is not implemented
- marketplace distribution is not implemented
- AgentAction policy engine is not implemented
- V5 is not complete

## Fixture Family Boundary

Future reader fixtures should model local Shared Trust Package candidates that a
future reader may parse and classify.

The fixture family may include:

- valid reader input fixtures
- invalid reader input fixtures
- unsupported reader input fixtures
- non-claim boundary fixtures
- deterministic read-output expectation fixtures

This gate does not create any of those fixture files. It only defines their
future scope.

## Future Fixture Location

A later fixture implementation gate may choose a directory such as:

`test/fixtures/v5/runtime-reader/`

That path is a future candidate only. This PR must not create it.

Future fixture filenames should be deterministic and descriptive. Candidate
names may include:

- `valid-minimal-package.json`
- `valid-with-route-receipt.json`
- `valid-with-reasoning-metadata.json`
- `valid-with-provenance-metadata.json`
- `invalid-missing-package-id.json`
- `invalid-missing-issuer.json`
- `invalid-missing-subject.json`
- `invalid-missing-verdict.json`
- `invalid-unsupported-version.json`
- `invalid-malformed-reasoning-metadata.json`
- `invalid-route-receipt-claim-without-route-receipt.json`
- `invalid-trust-verification-status-claim.json`
- `invalid-runtime-exchange-claim.json`
- `invalid-signing-verification-claim.json`

These are future names only. No fixture JSON is added by this document.

## Future Valid Fixture Categories

Future valid reader fixtures should prove that a reader can parse package
candidates without granting trust.

Candidate valid categories:

- minimal readable package candidate
- package candidate with route receipt metadata
- package candidate with reasoning metadata
- package candidate with provenance metadata
- package candidate with explicit `nonClaims`
- package candidate produced from writer-helper-compatible shape

Valid fixtures should remain local, static, deterministic, and reviewable.

Valid fixtures must not imply that a package is trusted, verified, signed,
transported, connector-authorized, marketplace-ready, or policy-enforced.

## Future Invalid Fixture Categories

Future invalid reader fixtures should prove fail-closed behavior for malformed
or unsupported package candidates.

Candidate invalid categories:

- missing package identity
- missing schema version
- unsupported schema version
- missing issuer identity reference
- missing subject reference
- missing verdict metadata
- malformed verdict metadata
- missing route receipt metadata when route receipt support is claimed
- malformed route receipt metadata
- malformed reasoning metadata
- malformed provenance metadata
- unknown runtime claim fields
- trust-verification status claim
- runtime exchange claim
- signing or verification runtime claim
- A2A transport claim
- connector enforcement claim
- marketplace readiness claim
- AgentAction policy engine claim

Invalid fixtures should be static JSON inputs. They should not require network,
database, clock, random, connector, A2A, marketplace, or signing surfaces.

## Future Expected Result Boundary

A later fixture implementation gate may pair each fixture with expected reader
classification metadata.

Expected result metadata may include:

- `expectedOk`
- `expectedStatus`
- `expectedReasonCode`
- `expectedPackageId`
- `expectedNonClaimsPreserved`
- `expectedNoTrustGrant`

Expected status language must stay in the read, parse, and shape domain.

Allowed status examples:

- `readable`
- `malformed`
- `missing_required_field`
- `unsupported_version`
- `unsupported_claim`
- `blocked`

Forbidden status examples:

- `trusted`
- `verified`
- `signed`
- `authorized`
- `enforced`
- `marketplace_ready`

## Relationship To Writer Fixtures

Future reader fixtures may reuse writer-compatible package shapes as local
candidate inputs.

That does not mean:

- writer output is automatically trusted
- writer output is transported to a reader
- runtime exchange exists
- a reader implementation exists
- signing or verification exists

Reader fixture scope must not mutate writer fixtures or writer helper behavior.

## Explicit Non-Claims

Completion of this docs-only gate will not mean:

- reader fixture files exist
- reader tests exist
- runtime reader exists
- runtime exchange exists
- runtime writer changed
- packages are signed
- signatures are verified
- packages are cryptographically trusted
- packages move between agents
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- V5 is complete

## Forbidden Work In This Gate

This gate must not add or modify:

- fixture JSON files
- test files
- runtime reader implementation
- runtime writer implementation
- schema files
- validator files
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace code
- AgentAction policy engine
- package files
- MCP, server, kernel, graph, or CLI behavior

## Future Gate Sequence

If this scope definition is merged and closed cleanly, the expected reader
sequence remains:

1. `V5-IMPL-3C_RUNTIME_READER_TEST_SCOPE_DEFINITION`
2. `V5-IMPL-3D_RUNTIME_READER_IMPLEMENTATION_SCOPE_DEFINITION`
3. reader fixtures
4. reader tests
5. reader helper implementation
6. reader closeout audit

Actual reader fixture files must only be added after a separate source-bound
decision explicitly authorizes a fixture-only gate.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-impl-3b-runtime-reader-fixture-scope-definition.md`
- `git diff --check` passes
- no fixture files are added
- no test files are added
- no implementation files changed
- no schema, validator, package, runtime, MCP, server, kernel, graph, or CLI
  files changed
- the document does not claim reader fixtures exist
- the document does not claim reader implementation exists
- the document does not claim V5 is complete

## Recommended Next Gate

After merge and closeout audit:

`V5-IMPL-3C_RUNTIME_READER_TEST_SCOPE_DEFINITION`

That next gate should remain docs-only unless a separate source-bound decision
explicitly authorizes actual test files.
