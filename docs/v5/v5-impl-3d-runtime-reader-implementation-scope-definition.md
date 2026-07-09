# V5-IMPL-3D - Runtime Reader Implementation Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-3C_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 05cfed5282c911eb2c035183a019b3780fa54624`

## Purpose

`V5-IMPL-3D` defines the narrow future implementation boundary for a local
Shared Trust Package reader helper.

This document does not implement a reader. It identifies the candidate input,
output, responsibilities, failure categories, and file boundary that a later
implementation gate may use after separate approval.

## Source Basis

The reader preparation chain is currently docs-only:

- `V5-IMPL-3A` defined the reader responsibility boundary.
- `V5-IMPL-3B` defined future reader fixture families.
- `V5-IMPL-3C` defined future reader test assertions.
- `V5-IMPL-3C_CLOSEOUT_AUDIT_GREEN` sealed the test scope without adding tests.

This gate only turns those boundaries into an implementation-scope proposal.
It does not authorize implementation by itself.

## Current Runtime Status

At this checkpoint:

- runtime writer helper exists
- runtime reader is not implemented
- reader fixtures are not added
- reader tests are not added
- runtime exchange is not implemented
- signing runtime is not implemented
- verification runtime is not implemented
- A2A transport is not implemented
- connector enforcement is not implemented
- marketplace distribution is not implemented
- AgentAction policy engine is not implemented
- V5 is not complete

## Candidate Implementation Boundary

A later implementation gate may add one local reader helper, for example:

`lib/v5/runtime-reader.js`

The candidate helper may accept a package candidate object and return a new,
deterministic structured read result. It must not read from network, database,
persistent package storage, connector payloads, marketplace records, A2A
messages, or runtime exchange paths.

The candidate helper must not mutate the input object or global state.

## Candidate Reader Responsibilities

If separately authorized, the reader helper may:

- accept a plain local package candidate object
- parse the package envelope
- verify required field presence and basic shape
- preserve package identity, issuer, subject, verdict, and non-claims data
- preserve route receipt, reasoning, and provenance metadata when present
- recognize the supported package schema version
- reject unsupported package versions
- reject malformed metadata
- reject unsupported runtime capability claims
- return deterministic structured success or failure output
- return deterministic reason codes for ordinary invalid candidates
- fail closed for missing required fields and unsupported claims

These responsibilities are shape/read semantics only. They do not establish
trust, authorization, authenticity, or enforcement.

## Candidate Input Contract

The later helper may accept only an in-memory package candidate with fields
already described by the existing Shared Trust Package contract, including:

- `schemaVersion`
- `packageId`
- `issuer.agentId`
- `issuer.workspaceId`
- `subject.type`
- `subject.id`
- `verdict.status`
- `nonClaims`
- optional route receipt metadata
- optional reasoning metadata
- optional provenance metadata

Input validation must remain local and deterministic. Remote locations, file
paths, persistent stores, transport envelopes, signatures, and connector data
are outside this scope.

## Candidate Output Contract

The later helper may return a new object containing read/shape information such
as:

- `ok`
- `status`
- `packageId`
- `schemaVersion`
- normalized package metadata
- preserved `nonClaims`
- `errors`
- `warnings`

Allowed status language remains limited to the read, parse, and shape domains:

- `readable`
- `malformed`
- `missing_required_field`
- `unsupported_version`
- `unsupported_claim`
- `blocked`

The output must not use `trusted`, `verified`, `signed`, `authorized`,
`enforced`, or `marketplace_ready` as a trust decision.

## Fail-Closed Requirements

A later implementation must reject, with deterministic structured errors, at
least these categories:

- non-object input
- missing package identity
- missing schema version
- unsupported schema version
- missing issuer identity reference
- missing workspace binding
- missing subject reference
- missing verdict metadata
- malformed route receipt metadata
- route receipt claims without required route receipt data
- malformed reasoning metadata
- malformed provenance metadata
- unknown or unsupported runtime claim fields
- trust-verification status claims
- signing or verification runtime claims
- runtime exchange claims
- A2A transport claims
- connector enforcement claims
- marketplace readiness claims
- AgentAction policy claims

Ordinary invalid candidates should produce a structured result rather than
throwing. Exceptional input behavior, if ever needed, requires a later
source-bound decision.

## Determinism and Purity Requirements

A later implementation must prove that:

- the same input produces the same output
- output does not depend on wall-clock time
- output does not depend on randomness or network state
- output does not require persistent storage
- input objects are not mutated
- global state is not mutated
- output does not grant trust or authorization

## Relationship To Existing Writer

The reader may consume a writer-helper-compatible object as a local candidate.
This does not create a writer/reader exchange system.

The later implementation must not:

- modify `lib/v5/runtime-writer.js`
- modify writer fixtures or writer tests
- treat writer output as trusted
- persist or transport writer output
- add signing or verification behavior

## Candidate File Boundary

If a separate implementation authorization is granted, the default narrow file
proposal is:

- `lib/v5/runtime-reader.js`

Any tests, fixtures, schema changes, validator changes, or documentation changes
must be handled by separate explicitly scoped gates. They are not included in
this scope-definition PR.

## Forbidden Work

This scope definition does not permit:

- runtime reader implementation
- runtime writer mutation
- reader test files
- reader fixture files
- schema or validator changes
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace code
- AgentAction policy engine
- package dependency changes
- MCP, server, kernel, graph, or CLI behavior
- UI or Workbench changes
- network, persistence, or package exchange behavior

## Explicit Non-Claims

Completion of this docs-only gate will not mean:

- runtime reader exists
- reader tests exist
- reader fixtures exist
- runtime exchange exists
- writer/reader transport exists
- packages are signed
- signatures are verified
- packages are cryptographically trusted
- packages move between agents
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- V5 is complete

## Future Sequence

After this scope definition is reviewed and closed, the safe sequence remains:

1. separate implementation authorization
2. reader fixture gate, if required
3. reader test gate, if required
4. narrow reader helper implementation
5. reader closeout audit

No implementation should begin solely because this document is merged.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-impl-3d-runtime-reader-implementation-scope-definition.md`
- `git diff --check` passes
- no reader implementation is added
- no test or fixture files are added
- no schema, validator, package, runtime, MCP, server, kernel, graph, or CLI
  files change
- the document does not claim reader implementation exists
- the document does not claim V5 is complete

## Recommended Next Gate

`NEXT-GATE-SELECTION_AFTER_V5-IMPL-3D_SCOPE_DEFINITION`

That decision must determine whether the source authorizes a separate reader
fixture/test gate or a narrowly authorized implementation PR. It must preserve
all non-claims above.
