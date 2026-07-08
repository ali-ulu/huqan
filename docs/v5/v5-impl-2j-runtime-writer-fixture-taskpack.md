# V5-IMPL-2J - Runtime Writer Fixture Task-Pack

**Mode:** Task-pack only
**Current checkpoint:** `V5-IMPLEMENTATION-READINESS-AUDIT-0_READY`
**Canonical branch:** `main`
**Required base:** `main @ 04a8bdaa0c311c74a5c5ccb241a2332ce89f90e2`

## Purpose

`V5-IMPL-2J` defines a docs-only task-pack for a future Runtime Writer fixture
PR.

This document does not add fixture files. It only defines what future fixtures
should prove before HUQAN considers runtime writer implementation work.

## Source Basis

The source chain requires fixture readiness before runtime writer work:

- `V5-IMPL-2F` defined the future runtime writer boundary.
- `V5-IMPL-2G` defined future writer fixture categories.
- `V5-IMPL-2H` defined future writer test scope.
- `V5-IMPL-2I` defined future writer implementation scope, but did not
  implement or approve runtime writer code.
- `V5-IMPLEMENTATION-READINESS-AUDIT-0_READY` selected writer fixture task-pack
  as the next safe gate before any implementation task-pack.

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
- actual writer fixture files are not added by this PR
- actual writer tests are not added by this PR
- V5 is not complete

## Why Fixture Task-Pack Comes Before Runtime Writer Implementation

Runtime writer implementation requires stable examples of valid and invalid
writer inputs before code can be safely written.

The fixture task-pack comes first because it should define:

- the minimum valid writer input shape
- optional metadata cases that must remain valid
- invalid inputs that must fail closed
- disallowed claims that must be rejected
- deterministic package id expectations
- no-network, no-randomness, and no-wall-clock boundaries
- naming and directory conventions for future fixture files

Without these fixture boundaries, writer implementation would risk encoding
implicit behavior that is not reviewable.

## Future Fixture File Plan

A later fixture PR may propose these paths:

- `fixtures/v5/runtime-writer/valid/minimal-writer-input.json`
- `fixtures/v5/runtime-writer/valid/route-receipt-metadata.json`
- `fixtures/v5/runtime-writer/valid/reasoning-metadata.json`
- `fixtures/v5/runtime-writer/valid/provenance-metadata.json`
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

These paths are future plans only. This PR must not create them.

## Future Valid Fixture Cases

Future valid fixtures should include:

- valid minimal writer input
- valid route receipt metadata
- valid reasoning metadata
- valid provenance metadata
- valid issuer identity
- valid workspace identity
- valid deterministic package id source

Each valid fixture should include only the minimum required fields for its case
and should avoid claiming runtime exchange, signing, verification, reader
behavior, connector enforcement, marketplace distribution, or AgentAction
policy behavior.

## Future Invalid Fixture Cases

Future invalid fixtures should include:

- missing agent identity
- missing workspace identity
- missing trust package identity
- missing verdict status
- malformed route receipt metadata
- malformed reasoning metadata
- unsigned-but-claimed-signed package
- runtime reader claim
- connector enforcement claim
- marketplace claim
- AgentAction policy engine claim
- unsupported schema version
- network-dependent input
- randomness-dependent input
- wall-clock-dependent input

Each invalid fixture should define the expected fail-closed reason category.

## Expected Fixture Naming Convention

Future fixture names should be:

- lowercase
- hyphen-separated
- deterministic
- grouped by `valid/` and `invalid/`
- scoped to one reason or proof case per file

Valid fixtures should describe the accepted feature. Invalid fixtures should
describe the rejected condition.

## Future Fixture Acceptance Criteria

A future fixture PR should be accepted only if:

- fixture files are deterministic
- fixture files contain no secrets or local paths
- valid fixtures do not overclaim runtime behavior
- invalid fixtures clearly map to fail-closed reason categories
- no fixture requires network access
- no fixture requires model output
- no fixture requires random values
- no fixture requires wall-clock time
- no fixture claims signing without a signing gate
- no fixture claims verification without a verification gate
- no fixture claims reader/export behavior without a reader gate
- no fixture claims A2A, connector, marketplace, or AgentAction behavior

## Future Fixture Stop Conditions

A future fixture PR must stop if:

- it needs runtime writer code
- it needs runtime reader code
- it needs signing or verification runtime
- it needs A2A transport
- it needs connector enforcement
- it needs marketplace behavior
- it needs AgentAction policy engine behavior
- it needs package dependency changes
- it needs schema changes
- it needs validator changes
- it adds tests before a test task-pack is approved
- any fixture includes secrets, credentials, or local machine paths
- any fixture claims V5 is complete

## Non-Runtime Boundary

The fixture task-pack is not runtime behavior.

Future fixtures may describe input and expected outcome shapes, but they must
not create:

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
- fixture files were added
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

- only `docs/v5/v5-impl-2j-runtime-writer-fixture-taskpack.md` changes
- no fixture files are added
- no test files are added
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

`V5-IMPL-2J_RUNTIME_WRITER_FIXTURE_TASKPACK_CLOSEOUT_AUDIT`

Only after that closeout should HUQAN decide whether to open a narrow writer
fixture implementation PR.
