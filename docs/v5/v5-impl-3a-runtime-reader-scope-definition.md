# V5-IMPL-3A - Runtime Reader Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-2P_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 325884d9907e1a5a20bef7258c5e62e7f144735c`

## Purpose

`V5-IMPL-3A` defines the future scope boundary for a Shared Trust Package
runtime reader.

This document does not implement a reader. It only states what a later reader
scope may be allowed to cover, which responsibilities must remain out of
scope, and which non-claims must stay locked before any reader implementation
PR can be opened.

## Source Basis

The source chain closed the writer helper path before considering reader work:

- `V5-IMPL-2O` added the runtime writer helper.
- `V5-IMPL-2P` bound the writer helper to the runtime-writer fixture contract.
- `V5-IMPL-2P_CLOSEOUT_AUDIT_GREEN` sealed the writer helper and fixture
  contract test.

The next safe architectural step is to define the reader boundary. This is a
docs-only gate and does not authorize reader implementation.

## Current Runtime Status

At this checkpoint:

- runtime writer helper exists
- runtime reader is not implemented
- runtime exchange is not implemented
- signing runtime is not implemented
- verification runtime is not implemented
- A2A transport is not implemented
- connector enforcement is not implemented
- marketplace distribution is not implemented
- AgentAction policy engine is not implemented
- V5 is not complete

## Runtime Reader Responsibility Boundary

A future runtime reader may be scoped to consume a local Shared Trust Package
candidate and return a deterministic structured read result.

The reader responsibility may include:

- accepting a package candidate object
- parsing the package envelope without mutating it
- normalizing known package fields into a read result
- checking required package identity fields are present
- checking issuer, subject, verdict, reasoning metadata, provenance references,
  and explicit non-claims are readable
- checking route receipt metadata when the package claims route receipt support
- preserving explicit `nonClaims`
- returning deterministic success or failure output
- returning structured reason codes for malformed input
- failing closed for missing required fields
- failing closed for unsupported package versions
- failing closed for packages that claim unsupported runtime capabilities

These are future responsibilities only. No reader is created by this document.

## Reader Input Boundary

A future reader scope must define the exact accepted input shape before code is
written.

Candidate reader inputs may include:

- a Shared Trust Package candidate object produced by the writer helper
- a fixture-backed package object
- package identity metadata
- issuer agent and workspace references
- subject reference
- verdict metadata
- route receipt metadata
- reasoning metadata
- provenance metadata
- explicit non-claims

The reader must not accept network locations, remote package URLs, connector
payloads, marketplace records, A2A messages, or signed envelopes unless later
gates explicitly authorize those surfaces.

The reader must also not accept persistent package stores or runtime exchange
payloads unless a later gate explicitly authorizes those surfaces.

## Reader Output Boundary

A future reader output may include:

- `ok`
- `status`
- `packageId`
- `schemaVersion`
- `issuer`
- `subject`
- `verdict`
- `routeReceipt`
- `reasoningMetadata`
- `provenance`
- `nonClaims`
- `errors`
- `warnings`

The output must be deterministic for the same input.

The output must not claim that a package is trusted, signed, verified,
transported, connector-authorized, marketplace-ready, or policy-enforced unless
separate later gates implement and validate those capabilities.

Allowed reader status language should stay in the read, parse, and shape domain,
such as:

- `readable`
- `malformed`
- `missing_required_field`
- `unsupported_version`
- `unsupported_claim`
- `blocked`

Reader output must not use trust-verification status language, such as:

- `trusted`
- `verified`
- `signed`
- `authorized`
- `enforced`
- `marketplace_ready`

## Fail-Closed Boundary

A future reader must fail closed for at least:

- missing package identity
- missing or unsupported schema version
- missing issuer identity reference
- missing subject reference
- missing verdict metadata
- missing route receipt metadata when the package claims route receipt support
- malformed reasoning metadata
- malformed provenance metadata
- unknown runtime claim fields
- reader claims that imply verification, signing, exchange, connector
  enforcement, marketplace distribution, or AgentAction policy support

Failure output should be structured and deterministic. It must not throw for
ordinary invalid package candidates unless the later implementation gate
explicitly defines an exceptional input class.

## Relationship To Writer Helper

The reader scope follows the writer helper but does not change it.

Future reader work may use writer output as a candidate input for read-only
tests. That does not mean the writer and reader are a runtime exchange system.

This scope does not permit:

- changing `lib/v5/runtime-writer.js`
- changing writer fixture files
- changing writer tests
- changing Shared Trust Package schema behavior
- adding package transport or persistence
- treating writer output as trusted without reader validation

## Explicit Non-Claims

Completion of this docs-only gate will not mean:

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

- runtime reader implementation
- runtime writer implementation
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace code
- AgentAction policy engine
- schema files
- fixture files
- test files
- package files
- MCP, server, kernel, graph, or CLI behavior

## Future Gate Sequence

If this scope definition is merged and closed cleanly, the expected next reader
sequence is:

1. `V5-IMPL-3B_RUNTIME_READER_FIXTURE_SCOPE_DEFINITION`
2. `V5-IMPL-3C_RUNTIME_READER_TEST_SCOPE_DEFINITION`
3. `V5-IMPL-3D_RUNTIME_READER_IMPLEMENTATION_SCOPE_DEFINITION`
4. reader fixtures
5. reader tests
6. reader helper implementation
7. reader closeout audit

Each later gate must preserve the non-claims unless it explicitly scopes,
implements, tests, reviews, merges, and closes that capability.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-impl-3a-runtime-reader-scope-definition.md`
- `git diff --check` passes
- no implementation files changed
- no schema, fixture, test, package, runtime, MCP, server, kernel, graph, or CLI
  files changed
- the document does not claim reader implementation exists
- the document does not claim V5 is complete

## Recommended Next Gate

After merge and closeout audit:

`V5-IMPL-3B_RUNTIME_READER_FIXTURE_SCOPE_DEFINITION`

That next gate should remain docs-only unless a separate source-bound decision
explicitly authorizes actual fixture files.
