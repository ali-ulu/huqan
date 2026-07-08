# V5-IMPL-2G - Runtime Writer Fixtures Scope Definition

**Mode:** Scope definition only
**Current checkpoint:** `V5-IMPL-2F_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ bed59574271aa3c2cde24ef1191520bd1b998bf1`

## Purpose

`V5-IMPL-2G` defines the future fixture scope for a Shared Trust Package
runtime writer.

This document does not add fixture files. It only defines what future writer
fixtures should prove before any writer implementation can start.

## Scope Boundary

`V5-IMPL-2G` is docs-only. It may describe future fixture categories,
acceptance criteria, non-claims, and stop conditions.

It must not implement:

- runtime writer behavior
- runtime reader behavior
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace distribution
- AgentAction policy engine

It must not add schemas, validators, tests, package dependencies, or actual
fixture JSON files.

## Future Fixture Categories

A later fixture PR may define categories for:

- valid writer input
- invalid writer input
- deterministic writer input
- provenance-aware writer input
- route receipt-aware writer input
- reasoning metadata-aware writer input
- forbidden runtime-claim input
- malformed metadata input

These categories are future planning targets only.

## Required Future Valid Fixture Types

Future valid fixtures may include:

- valid minimal writer input
- valid writer input with route receipt metadata
- valid writer input with reasoning metadata
- valid writer input with provenance metadata
- valid writer input with explicit issuer identity
- valid writer input with explicit workspace identity
- valid writer input with a source Trust Receipt reference
- valid writer input with a deterministic package id source

Each future valid fixture should map to the existing Shared Trust Package
schema and validator expectations.

## Required Future Invalid Fixture Types

Future invalid fixtures may include:

- invalid missing agent identity
- invalid missing workspace identity
- invalid missing trust package identity
- invalid missing verdict status
- invalid missing route receipt metadata
- invalid malformed route receipt metadata
- invalid missing reasoning metadata where required
- invalid malformed reasoning metadata
- invalid unsigned-but-claimed-signed package
- invalid runtime-reader claim
- invalid connector-enforcement claim
- invalid marketplace claim
- invalid AgentAction policy engine claim
- invalid unsupported schema version

Each future invalid fixture should fail closed with a stable expected reason.

## Required Future Conformance Expectations

Future writer fixture coverage should prove:

- required writer inputs are explicit
- missing required inputs fail closed
- malformed metadata fails closed
- runtime claim fields fail closed
- signing claims fail closed unless a later signing gate explicitly exists
- reader claims fail closed
- A2A, connector, marketplace, and AgentAction claims fail closed
- fixture inputs can be validated before any package is emitted
- fixture shape can be checked without runtime persistence
- fixture validation does not require network, model output, random sources, or wall-clock time

## Explicit Non-Runtime Boundary

The fixture scope is not runtime behavior.

Future fixtures may describe inputs and expected outcomes, but they must not
create a package writer, package reader, export path, persistence path,
signing path, verification runtime, A2A transport, connector enforcement, or
marketplace distribution.

## Required Non-Claims

After `V5-IMPL-2G`, do not claim:

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

## Forbidden Implementation Work

This PR must not modify or add:

- `schemas/**`
- `test/**`
- `test/fixtures/**`
- `lib/**`
- `server.js`
- `mcpServer.js`
- `kernel.js`
- `graph.js`
- `cli.js`
- `package.json`
- `package-lock.json`
- runtime writer code
- runtime reader code
- signing code
- verification runtime code
- A2A code
- connector enforcement code
- marketplace code
- AgentAction policy engine code

## Exit Criteria For This Docs PR

This docs-only scope PR is complete only if:

- only `docs/v5/v5-impl-2g-runtime-writer-fixtures-scope-definition.md` changes
- no fixture files are added
- no schema files change
- no validator files change
- no test files change
- no runtime files change
- no package files change
- `git diff --check` passes
- `git status --short` is clean after commit
- no writer, reader, signing, verification, A2A, connector, marketplace, or AgentAction capability is claimed

## Proposed Next Review Gate

The next review gate for this docs-only PR is:

`V5-IMPL-2G_RUNTIME_WRITER_FIXTURES_SCOPE_DEFINITION_READY_FOR_READ_ONLY_REVIEW`

## Recommended Next Decision After Merge

After review, merge, and post-merge smoke:

- perform `V5-IMPL-2G_CLOSEOUT_AUDIT`
- only then decide whether a future writer fixture implementation scope should open

Do not create fixture files from this PR.
