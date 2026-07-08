# V5-IMPL-2L - Runtime Writer Test Task-Pack

**Mode:** Task-pack only  
**Current checkpoint:** `NEXT-GATE-SELECTION_AFTER_V5-IMPL-2K_CLOSEOUT_GREEN`  
**Canonical branch:** `main`  
**Required base:** `main @ 51d7db3cad4a4fb060c53fba20fe2e6cba8cc8b9`

## Purpose

`V5-IMPL-2L` defines a docs-only task-pack for a future Runtime Writer test PR.

This document does not add test files. It only defines what future tests
should prove against the existing runtime-writer fixtures before HUQAN
considers any runtime writer implementation work.

## Source Basis

The source chain requires a separate test gate after fixture creation:

- `V5-IMPL-2H` defined runtime writer test scope, but did not authorize test
  file creation.
- `V5-IMPL-2J` separated fixture planning from test work and preserved the
  rule that tests require a separate gate.
- `V5-IMPL-2K` added 14 runtime-writer fixture JSON files and closed green as
  fixture-only.
- `NEXT-GATE-SELECTION_AFTER_V5-IMPL-2K_CLOSEOUT_GREEN` selected a docs-only
  runtime writer test task-pack as the next safe gate.

This document does not approve test implementation by itself. It only defines
the future boundary for a narrow test-only PR.

## Current Readiness Status

At this checkpoint:

- runtime writer is not implemented
- runtime reader is not implemented
- signing runtime is not implemented
- verification runtime is not implemented
- A2A transport is not implemented
- connector enforcement is not implemented
- marketplace distribution is not implemented
- AgentAction policy engine is not implemented
- 14 runtime-writer fixture JSON files exist
- actual runtime writer test files are not added by this PR
- schema files are unchanged by this PR
- validator files are unchanged by this PR
- package files are unchanged by this PR
- V5 is not complete

## Why Test Task-Pack Comes Before Real Test Files

Real test files should not be added until HUQAN locks:

- which fixture cases must be asserted as valid
- which fixture cases must fail closed
- what deterministic assertions are allowed
- what overclaim checks must be mandatory
- which dependencies must remain forbidden
- what exact file boundary future test work must preserve

Without this task-pack, a future test PR could silently widen scope into
schema, validator, fixture mutation, or runtime behavior.

## Future Test File Plan

A later test-only PR may propose a narrow file boundary such as:

- `test/v5-runtime-writer-fixtures.test.js`

This path is a future plan only. It is not created or authorized by this PR.

Any later test PR must re-declare its exact allowed files before work starts.

## Future Valid Fixture Test Cases

Future tests may verify that these fixtures remain accepted as valid writer
input cases:

- `fixtures/v5/runtime-writer/valid/minimal-writer-input.json`
- `fixtures/v5/runtime-writer/valid/route-receipt-metadata.json`
- `fixtures/v5/runtime-writer/valid/reasoning-metadata.json`
- `fixtures/v5/runtime-writer/valid/provenance-metadata.json`

Future valid-case tests should prove:

- each file parses as deterministic JSON
- each file represents an accepted writer-input category
- valid inputs do not overclaim runtime behavior
- valid inputs do not require network, randomness, or wall-clock time
- valid inputs do not imply writer, reader, signing, verification, A2A,
  connector, marketplace, or AgentAction implementation

## Future Invalid Fixture Test Cases

Future tests may verify that these fixtures remain fail-closed input cases:

- `fixtures/v5/runtime-writer/invalid/missing-agent-identity.json`
- `fixtures/v5/runtime-writer/invalid/missing-workspace-identity.json`
- `fixtures/v5/runtime-writer/invalid/missing-trust-package-identity.json`
- `fixtures/v5/runtime-writer/invalid/malformed-route-receipt-metadata.json`
- `fixtures/v5/runtime-writer/invalid/malformed-reasoning-metadata.json`
- `fixtures/v5/runtime-writer/invalid/unsigned-but-claimed-signed.json`
- `fixtures/v5/runtime-writer/invalid/runtime-reader-claim.json`
- `fixtures/v5/runtime-writer/invalid/connector-enforcement-claim.json`
- `fixtures/v5/runtime-writer/invalid/marketplace-claim.json`
- `fixtures/v5/runtime-writer/invalid/agentaction-policy-engine-claim.json`

Future invalid-case tests should prove:

- each file parses as deterministic JSON
- each invalid case maps to a fail-closed expectation
- each invalid case preserves a deterministic `reason_category`
- each invalid case remains blocked without package emission
- runtime-claim fixtures fail closed instead of widening behavior

## Expected Test Naming Convention

Future test names should be:

- explicit
- deterministic
- one semantic expectation per test
- grouped by valid and invalid fixture behavior
- readable without hidden fixture mutation

Suggested naming style:

- `accepts minimal runtime writer input fixture`
- `rejects runtime reader claim fixture`
- `rejects malformed reasoning metadata fixture`

## Expected Test-Only Boundary

A future runtime writer test PR may:

- load existing fixture JSON files
- assert valid fixture expectations
- assert invalid fixture expectations
- assert deterministic `reason_category` behavior
- assert no secrets, no local paths, and no forbidden runtime claims

It must not:

- add new fixture files
- modify existing fixture files
- change schemas
- change validators
- implement runtime writer logic
- implement runtime reader logic
- add signing or verification runtime
- add A2A transport
- add connector enforcement
- add marketplace behavior
- add AgentAction policy engine behavior
- change package files

## Future Acceptance Criteria

A future test-only PR should be accepted only if:

- tests cover all 14 runtime-writer fixture files
- valid fixtures are asserted as accepted writer inputs
- invalid fixtures are asserted as fail-closed inputs
- each invalid fixture preserves a deterministic `BLOCK` expectation shape
- each invalid fixture preserves a deterministic `reason_category`
- tests verify fixture files contain no secrets, credentials, tokens, or local
  machine paths
- tests verify fixture files contain no network dependency
- tests verify fixture files contain no randomness dependency
- tests verify fixture files contain no wall-clock dependency
- tests verify fixtures do not claim runtime writer implementation exists
- tests verify fixtures do not claim runtime reader implementation exists
- tests verify fixtures do not claim signing or verification runtime exists
- tests verify fixtures do not claim A2A, connector enforcement, marketplace,
  or AgentAction capability exists
- tests do not mutate fixtures
- tests do not require runtime writer code

## Future Stop Conditions

A future test PR must stop immediately if:

- test requires runtime writer implementation
- test requires runtime reader implementation
- test requires signing or verification runtime
- test requires A2A transport
- test requires connector enforcement
- test requires marketplace behavior
- test requires AgentAction policy engine behavior
- test requires package dependency changes
- test requires schema changes
- test requires validator changes
- test mutates fixtures
- test depends on network access
- test depends on model output
- test depends on randomness
- test depends on wall-clock time
- test claims V5 is complete

## Runtime Non-Implementation Boundary

The test task-pack is not runtime behavior.

Future tests may validate fixture expectations, but they must not create:

- runtime writer code
- runtime reader code
- package persistence
- package export
- package exchange
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine behavior

## Required Non-Claims

After this task-pack PR, do not claim:

- runtime writer implementation exists
- runtime reader implementation exists
- signing runtime exists
- verification runtime exists
- A2A transport exists
- connector enforcement exists
- marketplace exists
- AgentAction policy engine exists
- schema changes were made
- validator changes were made
- new fixture files were added
- test files were added
- package changes were made
- V5 is complete

## Forbidden Implementation Work

This PR must not modify or add:

- `package.json`
- `package-lock.json`
- `schemas/**`
- `fixtures/**`
- `test/**`
- `tests/**`
- `lib/**`
- `server.js`
- `mcpServer.js`
- `kernel.js`
- `graph.js`
- `cli.js`
- runtime writer code
- runtime reader code
- signing runtime code
- verification runtime code
- A2A code
- connector enforcement code
- marketplace code
- AgentAction policy engine code

## Exit Criteria For This Docs-Only PR

This docs-only task-pack PR is complete only if:

- only `docs/v5/v5-impl-2l-runtime-writer-test-taskpack.md` changes
- no test files are added
- no fixture files are modified or added
- no schema files change
- no validator files change
- no runtime files change
- no package files change
- `git diff --check` passes
- `git status --short` is clean after commit
- no runtime, exchange, signing, verification, connector, marketplace, or
  AgentAction capability is claimed

## Next-Gate Recommendation

If this PR is reviewed, merged, and closed green, the next safe gate is:

`V5-IMPL-2L_RUNTIME_WRITER_TEST_TASKPACK_CLOSEOUT_AUDIT`

Only after that closeout should HUQAN decide whether to open a narrow
runtime-writer test implementation PR.
