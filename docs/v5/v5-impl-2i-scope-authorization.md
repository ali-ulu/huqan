# V5-IMPL-2I - Runtime Writer Scope Authorization

**Mode:** Authorization document only
**Current checkpoint:** `ROADMAP-CHECK_BEFORE_V5-IMPL-2I_NEEDS_SOURCE_UPDATE`
**Canonical branch:** `main`
**Required base:** `main @ 066dca52f6e0ea24919a971bbc632f9910ff7e7f`

## Purpose

`V5-IMPL-2I` currently exists only as a candidate future gate. This document
defines whether a later `V5-IMPL-2I_RUNTIME_WRITER_IMPLEMENTATION_SCOPE_DEFINITION`
gate may be opened, and what boundaries that future gate must preserve.

This authorization document does not start runtime writer implementation.

## Current Source Status

The current source record says:

- `V5-IMPL-2F` listed `V5-IMPL-2I_RUNTIME_WRITER_IMPLEMENTATION_SCOPE_DEFINITION`
  as a candidate future gate only.
- `V5-IMPL-2F` did not approve any candidate future gate by itself.
- `V5-IMPL-2G` defined future writer fixture scope only.
- `V5-IMPL-2H` defined future writer test scope only.
- `V5-IMPL-2H` allowed only a later decision about whether future writer
  implementation scope can be discussed.
- runtime writer remains not implemented.
- runtime reader remains not implemented.
- signing runtime remains not implemented.
- verification runtime remains not implemented.

## Why 2I Cannot Start Directly

`V5-IMPL-2I` cannot start directly because the existing roadmap source treats it
as a candidate, not as an approved implementation gate.

Before any implementation work can begin, HUQAN must first approve a separate
scope-definition gate that states:

- what the future runtime writer is allowed to do
- which files may be changed
- which files and systems are forbidden
- which tests or evidence are required before implementation
- which stop conditions force the work to halt
- which non-claims remain in force

Without that boundary, moving directly from 2H to writer implementation would
create scope drift.

## Candidate-Gate Interpretation

`V5-IMPL-2I_RUNTIME_WRITER_IMPLEMENTATION_SCOPE_DEFINITION` may be interpreted
only as a future scope-definition candidate.

It does not mean:

- runtime writer is approved for implementation
- writer code may be added
- reader code may be added
- signing or verification runtime may be added
- A2A transport may be added
- connector enforcement may be added
- marketplace work may begin
- AgentAction policy engine work may begin

## Authorization Decision Criteria

A future `V5-IMPL-2I_RUNTIME_WRITER_IMPLEMENTATION_SCOPE_DEFINITION` may be
opened only if it remains docs-only and satisfies all criteria below:

- it defines implementation scope only
- it does not implement runtime writer
- it does not add writer code
- it does not add reader code
- it does not add signing runtime
- it does not add verification runtime
- it does not add A2A transport
- it does not add connector enforcement
- it does not add marketplace behavior
- it does not add AgentAction policy engine behavior
- it does not add schemas
- it does not add validators
- it does not add fixture files
- it does not add test files
- it does not modify package files
- it defines allowed files before any implementation PR
- it defines forbidden files before any implementation PR
- it defines stop conditions before any implementation PR
- it preserves all non-claims

## Allowed Future 2I Shape

A future 2I scope-definition document may discuss:

- runtime writer implementation scope definition
- writer responsibility boundary
- writer input contract expectations
- writer output contract expectations
- writer non-runtime dependencies
- writer fail-closed requirements
- writer determinism requirements
- writer non-mutation expectations
- allowed future implementation files, as a plan only
- forbidden future implementation files, as a plan only
- future review gates before implementation
- future validation gates before implementation

These topics are planning topics only until a later implementation gate is
separately approved.

## Forbidden Future 2I Shape

A future 2I scope-definition document must not:

- implement runtime writer
- implement runtime reader
- implement signing runtime
- implement verification runtime
- add package persistence
- add package export
- add A2A transport
- add connector enforcement
- add marketplace distribution
- add AgentAction policy engine
- add schemas
- add validators
- add fixtures
- add tests
- modify package files
- modify runtime files
- modify MCP behavior
- modify server or kernel behavior
- claim writer implementation approval

## Required Allowed-File Boundary For Future 2I

A future 2I scope-definition PR must declare its allowed files before work
starts.

The expected shape is docs-only, such as:

- `docs/v5/v5-impl-2i-runtime-writer-implementation-scope-definition.md`

Any future proposal that requires files outside docs must stop and open a new
authorization decision first.

## Required Forbidden-File Boundary For Future 2I

A future 2I scope-definition PR must keep these areas forbidden:

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

## Required Stop Conditions For Future 2I

A future 2I scope-definition loop must stop immediately if:

- the base HEAD does not match the approved checkpoint
- the worktree is dirty before starting
- any forbidden file changes
- any implementation appears
- runtime writer code is needed to complete the scope document
- runtime reader code is needed to complete the scope document
- signing or verification runtime is needed
- A2A, connector, marketplace, or AgentAction scope is needed
- package dependency changes are needed
- the document claims writer implementation exists
- the document claims reader implementation exists
- the document claims V5 runtime exchange exists

## Required Non-Claims

After this authorization document, do not claim:

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
- `V5-IMPL-2I` implementation is approved
- V5 is complete

## Exit Criteria For This Authorization PR

This docs-only authorization PR is complete only if:

- only `docs/v5/v5-impl-2i-scope-authorization.md` changes
- no schema files change
- no validator files change
- no fixture files are added
- no test files are added
- no runtime files change
- no package files change
- `git diff --check` passes
- `git status --short` is clean after commit
- no writer, reader, signing, verification, A2A, connector, marketplace, or
  AgentAction capability is claimed
- 2I remains an authorization decision, not an implementation start

## Next-Gate Recommendation

If this PR is reviewed, merged, and closed green, the next safe gate is:

`V5-IMPL-2I_SCOPE_AUTHORIZATION_DOC_CLOSEOUT_AUDIT`

Only after that closeout should HUQAN decide whether to open:

`V5-IMPL-2I_RUNTIME_WRITER_IMPLEMENTATION_SCOPE_DEFINITION`

That later gate must remain docs-only unless a separate implementation gate is
explicitly approved.
