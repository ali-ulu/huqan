# V5-IMPL-3H - Writer/Reader Local Contract Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-3G_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ be9c29a61a4389fb169b8fcb0650169b40025215`

## Purpose

`V5-IMPL-3H` defines the narrow local-only contract between the existing
runtime writer helper and runtime reader helper.

The intended flow is:

`writer output -> local in-memory candidate -> reader read/shape validation`

This document does not add a test, change either helper, or create a runtime
exchange system.

## Source Basis

The current helper chain is closed independently:

- `V5-IMPL-2O` added the runtime writer helper.
- `V5-IMPL-2P` bound writer behavior to its fixture contract.
- `V5-IMPL-3E` added the reader fixture corpus.
- `V5-IMPL-3F` bound the reader fixture corpus to tests.
- `V5-IMPL-3G` added the local runtime reader helper.
- `V5-IMPL-3G_CLOSEOUT_AUDIT_GREEN` sealed the reader helper boundary.

The helpers are available as separate local capabilities. Their existence does
not imply that packages can be exchanged between processes or agents.

## Local Contract Boundary

A future test-only gate may exercise this sequence in one process:

1. Build a valid writer input in memory.
2. Call the existing writer helper.
3. Take the returned local package candidate without transport or persistence.
4. Pass that candidate to the existing reader helper.
5. Assert deterministic read/shape output and preserved non-claims.

The candidate is an ordinary in-memory JavaScript object. The boundary ends
when the reader returns its local result.

## Allowed Future Assertions

A later test-only gate may assert that:

- the writer accepts an allowed local input
- the writer returns a package candidate
- the reader accepts that candidate as local input
- package identity and metadata are preserved
- explicit `nonClaims` are preserved exactly
- the reader returns deterministic `readable` shape status
- repeated writer-to-reader calls produce equal results
- neither helper mutates the input object unexpectedly
- invalid local candidates remain fail-closed
- reader output does not imply trust or authorization

These assertions describe a local contract only. They do not assert transport,
storage, identity exchange, or cryptographic capabilities.

## Candidate Data Boundary

The local candidate may contain the existing contract fields:

- `schemaVersion`
- `packageId`
- `issuer`
- `subject`
- `verdict`
- `nonClaims`
- optional route receipt metadata
- optional reasoning metadata
- optional provenance metadata

The reader remains responsible for local shape and claim validation. The writer
remains responsible for its own local input validation and package construction.
Neither helper becomes an authority service through this contract.

## Determinism and Isolation

A future local contract test must prove:

- same writer input produces the same writer output
- same reader candidate produces the same reader output
- output does not depend on network availability
- output does not depend on persistent storage
- output does not depend on agent-to-agent transport
- output does not depend on signing keys or verification services
- output does not mutate shared global state
- writer and reader calls remain in-process and local

## Required Fail-Closed Boundaries

A future local contract test must keep invalid or overclaiming candidates
blocked, including:

- unsupported schema version
- missing package or identity fields
- malformed route receipt metadata
- malformed reasoning or provenance metadata
- runtime reader or exchange claims
- signing or verification claims
- A2A transport claims
- connector enforcement claims
- marketplace claims
- AgentAction policy claims
- trust-verification status language

The reader may return structured local reason categories, but no result may be
interpreted as cryptographic verification, trust, authorization, or enforcement.

## Explicit Non-Claims

This scope does not mean:

- runtime exchange exists
- packages are transported
- packages are persisted
- packages move between agents
- writer output is trusted automatically
- reader output is verified
- packages are signed
- signatures are verified
- A2A transport exists
- connector enforcement exists
- marketplace distribution exists
- AgentAction policy engine exists
- runtime identity enforcement exists
- V5 is complete

The local in-memory handoff is a testable data flow, not a production exchange
or trust boundary.

## Forbidden Work In This Gate

This docs-only scope definition must not add or modify:

- `lib/v5/runtime-writer.js`
- `lib/v5/runtime-reader.js`
- `test/v5-runtime-writer-reader-local-contract.test.js`
- any fixture files
- schema or validator files
- package files
- persistence or transport code
- signing or verification runtime
- A2A, connector, marketplace, or AgentAction code
- MCP, server, kernel, graph, CLI, UI, or Workbench behavior

## Candidate Next Gate

If this document is merged and closed cleanly, the next narrow gate may be:

`V5-IMPL-3I_RUNTIME_WRITER_READER_LOCAL_CONTRACT_TEST`

That gate must be test-only and may add only:

`test/v5-runtime-writer-reader-local-contract.test.js`

It must not alter either helper or introduce any exchange, persistence,
transport, signing, verification, or ecosystem behavior.

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-impl-3h-writer-reader-local-contract-scope.md`
- `git diff --check` passes
- neither helper changes
- no test or fixture files change
- no schema, validator, package, runtime, transport, or persistence files
  change
- the document does not claim runtime exchange exists
- the document does not claim V5 is complete
