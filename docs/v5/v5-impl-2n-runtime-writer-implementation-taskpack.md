# V5-IMPL-2N - Runtime Writer Implementation Task-Pack

**Mode:** Task-pack only
**Current checkpoint:** `NEXT-GATE-SELECTION_AFTER_V5-IMPL-2M_CLOSEOUT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 87665ee2135e06c5ff0f42151d60a5c6a59993df`

## Purpose

`V5-IMPL-2N` defines a docs-only task-pack for a future narrow Runtime Writer
implementation PR.

This document does not implement runtime writer code. It only locks the file
boundary, test obligations, stop conditions, and non-claims that any later
runtime writer implementation PR must preserve.

## Source Basis

The source chain for this task-pack is:

- `V5-IMPL-2I` defined runtime writer implementation boundary but did not
  authorize implementation.
- `V5-IMPL-2J` established fixture readiness before implementation.
- `V5-IMPL-2K` added 14 runtime-writer fixture JSON files.
- `V5-IMPL-2L` established the future runtime writer test boundary.
- `V5-IMPL-2M` added test-only validation for the 14 runtime-writer fixtures.
- `V5-IMPL-2M` targeted test passed `4/4`.
- full suite passed `1726 pass / 0 fail / 29 skipped`.

This task-pack is a subgate of the existing macro roadmap item:

`Runtime writer fixtures / tests / implementation PR’ları`

It is not a roadmap change.

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
- fixture tests exist and pass
- schema and validator layers remain unchanged by this PR
- package files remain unchanged by this PR
- V5 is not complete

## Why Implementation Task-Pack Comes Before Runtime Writer Code

Even after fixture and test readiness, runtime writer code should not start
until HUQAN locks the exact implementation boundary.

The implementation task-pack comes first because it should define:

- which file boundary future code may use
- which existing tests must stay green
- which fail-closed behaviors are mandatory
- which side effects remain forbidden
- which dependencies remain forbidden
- which broader runtime responsibilities stay out of scope

Without this task-pack, a future implementation PR could silently widen into
reader behavior, signing, verification, schema churn, validator churn,
connector enforcement, or package-level drift.

## Future Allowed Implementation File Boundary

A later narrow implementation PR may propose:

- `lib/v5/runtime-writer.js`

That path is a future planning candidate only. This PR must not create it.

Any future implementation PR must re-declare its exact allowed files before
work starts.

## Future Forbidden Implementation File Boundary

A future runtime writer implementation PR must not modify these areas unless a
separate authorization gate explicitly changes scope:

- `package.json`
- `package-lock.json`
- `schemas/**`
- `fixtures/**`
- `test/**`
- `tests/**`
- `lib/**` except the exact writer helper path re-approved in that PR
- `server.js`
- `mcpServer.js`
- `kernel.js`
- `graph.js`
- `cli.js`
- reader runtime files
- signing runtime files
- verification runtime files
- connector enforcement files
- A2A transport files
- marketplace files
- AgentAction policy engine files

## Runtime Writer Responsibility Boundary

A future runtime writer implementation may include only:

- accepting already validated Shared Trust Package writer input
- constructing deterministic writer output shape
- preserving route receipt metadata
- preserving reasoning metadata
- preserving provenance metadata
- rejecting malformed input fail-closed
- rejecting unsigned-but-claimed-signed input unless a signing gate exists
- rejecting runtime reader or export claims unless a reader gate exists
- avoiding network, model output, randomness, and wall-clock dependency

The writer must remain a local package construction helper only.

## Runtime Writer Input Boundary

A future runtime writer implementation PR may accept only explicit validated
inputs such as:

- schema version
- package identity
- issuer agent identity reference
- issuer workspace identity reference
- subject reference
- verdict metadata
- route receipt metadata
- reasoning metadata
- provenance metadata
- deterministic package id source
- non-claim list

It must not accept opaque broad runtime objects without a declared validation
boundary.

## Runtime Writer Output Boundary

A future runtime writer implementation PR may emit only a local Shared Trust
Package candidate object.

Its output must not imply:

- package persistence
- package export
- package import
- runtime exchange
- signing
- verification
- reader behavior
- A2A transport
- connector enforcement
- marketplace distribution

On invalid input, the writer must fail closed and emit no package.

## Required Deterministic Behavior

A future runtime writer implementation PR must preserve:

- identical canonical inputs produce identical package content
- package id generation is explicit and testable
- no network dependency for core package construction
- no external model dependency for core package construction
- no randomness dependency for core package construction
- no wall-clock dependency for deterministic comparison unless explicitly
  normalized
- any non-deterministic metadata is isolated and declared

## Required Fail-Closed Behavior

A future runtime writer implementation PR must fail closed when:

- package identity is missing
- schema version is unsupported
- issuer agent identity is missing
- issuer workspace identity is missing
- subject reference is missing
- verdict metadata is missing
- route receipt metadata is malformed
- reasoning metadata is malformed
- provenance metadata is malformed
- disallowed runtime claim fields are present
- signing claims appear before a signing gate exists
- verification claims appear before a verification gate exists
- reader or export claims appear before a reader gate exists
- A2A, connector, marketplace, or AgentAction claims appear
- validation prerequisites fail

Fail-closed means no valid package object is emitted.

## Required Non-Mutation / No Side-Effect Behavior

A future runtime writer implementation PR must not mutate input objects.

It must not:

- write to memory
- write to graph state
- write to audit state
- write to filesystem persistence paths
- enqueue approvals
- call MCP runtime
- call server routes
- call connector runtime
- create receipts
- alter existing receipts
- alter route receipt metadata
- alter reasoning metadata

## Required Persistence Boundary

A future runtime writer implementation PR may construct a package candidate,
but it must not persist, export, transmit, publish, or register that package.

The following remain outside scope:

- package persistence
- package export
- package import
- package exchange
- package registry
- marketplace publication
- external connector delivery
- A2A transport

## Required Signing Boundary

A future runtime writer implementation PR must not sign packages.

It must reject or fail closed on claims implying:

- package is signed
- signature was verified
- issuer key trust was resolved
- external certificate was checked
- cryptographic verification occurred

Signing requires a separate gate.

## Required Reader Boundary

A future runtime writer implementation PR must not read packages from exchange
paths.

It must not:

- import external packages
- validate external receiver trust
- perform package verification
- act as a package reader
- perform A2A receiver behavior
- perform connector receiver behavior

Reader behavior requires a separate gate.

## Required Connector / A2A / Marketplace / AgentAction Boundary

A future runtime writer implementation PR must not:

- add connector enforcement
- add connector delivery behavior
- add A2A transport
- add marketplace publish behavior
- add marketplace consume behavior
- add AgentAction policy engine behavior

Those remain separate roadmap branches and must not be absorbed into writer
implementation.

## Required Test Commands For A Future Implementation PR

Any future runtime writer implementation PR must at minimum run:

```bash
node --test test/v5-runtime-writer-fixtures.test.js
npm test
git diff --check main..HEAD
git status --short
```

Additional targeted writer tests may be required in that future PR, but must be
declared there explicitly.

## Required Stop Conditions

A future runtime writer implementation PR must stop immediately if:

- implementation requires schema changes
- implementation requires validator changes
- implementation requires package changes
- implementation requires reader or export behavior
- implementation requires signing or verification runtime
- implementation requires A2A transport
- implementation requires connector enforcement
- implementation requires marketplace behavior
- implementation requires AgentAction policy engine behavior
- implementation mutates fixtures
- implementation changes the existing test contract without separate approval
- implementation needs network access
- implementation needs model output
- implementation needs randomness
- implementation needs wall-clock time
- implementation claims V5 is complete

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
- schema changed
- validator changed
- fixtures changed
- tests changed
- package changed
- V5 is complete

## Exit Criteria For This Docs-Only PR

This docs-only task-pack PR is complete only if:

- only `docs/v5/v5-impl-2n-runtime-writer-implementation-taskpack.md` changes
- no runtime writer code is added
- no reader code is added
- no signing or verification runtime is added
- no fixture files change
- no test files change
- no schema files change
- no validator files change
- no package files change
- `git diff --check` passes
- `git status --short` is clean after commit
- no runtime or V5-complete claim is added

## Next-Gate Recommendation

If this PR is reviewed, merged, and closed green, the next safe gate is:

`V5-IMPL-2N_RUNTIME_WRITER_IMPLEMENTATION_TASKPACK_CLOSEOUT_AUDIT`

Only after that closeout should HUQAN decide whether a narrow runtime writer
implementation PR can open.
