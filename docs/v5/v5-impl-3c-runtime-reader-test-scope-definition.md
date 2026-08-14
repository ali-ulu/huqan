# V5-IMPL-3C - Runtime Reader Test Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-3B_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 751c619da877f256f6c224cd5968f3b81d27f7c7`

## Purpose

`V5-IMPL-3C` defines the future test coverage boundary for a Shared Trust
Package runtime reader.

This document does not add test files. It only defines what future reader tests
should assert, which fixture families they may use, and which non-claims must
remain locked before any actual reader test PR can be opened.

## Source Basis

The reader chain is still in docs-only preparation:

- `V5-IMPL-3A` defined the future runtime reader scope.
- `V5-IMPL-3B` defined the future runtime reader fixture scope.
- `V5-IMPL-3B_CLOSEOUT_AUDIT_GREEN` sealed that no actual reader fixtures,
  tests, or implementation were added.

`V5-IMPL-3C` is the next docs-only step: define future reader test categories
before adding test files.

This document does not authorize test implementation by itself.

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

## Future Test Family Boundary

Future reader tests should prove that a reader helper, once separately scoped
and implemented, parses local Shared Trust Package candidates deterministically
and fails closed for malformed or overclaiming inputs.

The future test family may include:

- valid fixture parsing tests
- invalid fixture fail-closed tests
- unsupported version tests
- unsupported claim tests
- non-claim preservation tests
- deterministic output tests
- writer-output boundary tests
- no-runtime-surface dependency tests

This gate does not create any of those test files. It only defines their future
scope.

## Future Test Location

A later test implementation gate may choose a file such as:

`test/v5-runtime-reader-fixtures.test.js`

That path is a future candidate only. This PR must not create it.

## Future Fixture Inputs

Future reader tests may use fixture families defined by `V5-IMPL-3B`, once a
separate fixture-only gate creates them.

Candidate fixture families:

- valid minimal package candidate
- valid package with route receipt metadata
- valid package with reasoning metadata
- valid package with provenance metadata
- valid package with explicit `nonClaims`
- invalid missing package identity
- invalid missing schema version
- invalid unsupported schema version
- invalid missing issuer identity reference
- invalid missing subject reference
- invalid missing verdict metadata
- invalid malformed verdict metadata
- invalid route receipt claim without route receipt metadata
- invalid malformed route receipt metadata
- invalid malformed reasoning metadata
- invalid malformed provenance metadata
- invalid trust-verification status claim
- invalid runtime exchange claim
- invalid signing or verification runtime claim
- invalid A2A, connector, marketplace, or AgentAction claim

This document does not add any fixture JSON files.

## Future Valid Test Assertions

Future valid reader tests should assert that a reader:

- accepts local package candidate objects only
- returns deterministic output for repeated reads of the same fixture
- returns read, parse, or shape-domain status language only
- preserves package identity metadata
- preserves issuer and subject references
- preserves verdict metadata
- preserves route receipt metadata when present
- preserves reasoning metadata when present
- preserves provenance metadata when present
- preserves explicit `nonClaims`
- does not mutate input fixtures
- does not grant trust
- does not claim signing or verification
- does not claim transport, connector enforcement, marketplace readiness, or
  AgentAction policy support

Valid tests must not treat a readable package as trusted.

## Future Invalid Test Assertions

Future invalid reader tests should assert fail-closed behavior for:

- missing required fields
- unsupported schema versions
- malformed metadata sections
- route receipt support claims without route receipt metadata
- unknown runtime claim fields
- trust-verification status language
- runtime exchange claims
- signing or verification runtime claims
- A2A transport claims
- connector enforcement claims
- marketplace readiness claims
- AgentAction policy engine claims

Invalid tests should expect structured deterministic reason codes.

Invalid tests should not require network, database, clock, random, connector,
A2A, marketplace, signing, or verification surfaces.

## Future Determinism Assertions

Future reader tests should assert:

- same input produces same output
- output does not depend on wall-clock time
- output does not depend on randomness
- output does not depend on network availability
- output does not depend on persistent package storage
- output does not mutate global state
- output does not mutate the fixture object

## Future Status Language Assertions

Future tests should restrict reader status values to read, parse, and shape
domain language.

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

## Future No-Dependency Assertions

Future reader tests should prove the reader helper does not require:

- runtime exchange paths
- runtime reader persistence
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine
- package dependency changes
- MCP, server, kernel, graph, or CLI behavior

## Relationship To Writer Tests

Future reader tests may use writer-helper-compatible package shapes as local
candidate inputs.

That does not mean:

- writer output is automatically trusted
- writer output is transported to a reader
- runtime exchange exists
- a reader implementation exists
- signing or verification exists

Reader test scope must not mutate writer tests, writer fixtures, or writer
helper behavior.

## Explicit Non-Claims

Completion of this docs-only gate will not mean:

- reader test files exist
- reader fixture files exist
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

- test files
- fixture JSON files
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

1. `V5-IMPL-3D_RUNTIME_READER_IMPLEMENTATION_SCOPE_DEFINITION`
2. reader fixtures
3. reader tests
4. reader helper implementation
5. reader closeout audit

Actual reader test files must only be added after a separate source-bound
decision explicitly authorizes a test-only gate.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-impl-3c-runtime-reader-test-scope-definition.md`
- `git diff --check` passes
- no test files are added
- no fixture files are added
- no implementation files changed
- no schema, validator, package, runtime, MCP, server, kernel, graph, or CLI
  files changed
- the document does not claim reader tests exist
- the document does not claim reader fixtures exist
- the document does not claim reader implementation exists
- the document does not claim V5 is complete

## Recommended Next Gate

After merge and closeout audit:

`V5-IMPL-3D_RUNTIME_READER_IMPLEMENTATION_SCOPE_DEFINITION`

That next gate should remain docs-only unless a separate source-bound decision
explicitly authorizes runtime reader implementation work.
