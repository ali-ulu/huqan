# V5-IMPL-2D - Shared Trust Package Conformance Readiness Scope

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `PLAN-REENTRY_CHECK_CODE_FIRST_CONTINUE`
**Canonical branch:** `main`
**Required base:** `main @ 34b8844a51268618e4d8508d5abfc46e366fb2b3`

## Purpose

`V5-IMPL-2D` defines the next narrow contract/conformance step after
`V5-IMPL-2C`.

`V5-IMPL-2C` closed the Shared Trust Package validator helper and validator
tests for the selected fixture/schema subset. `V5-IMPL-2D` must decide the
next readiness boundary before any runtime writer, reader, signing, exchange,
connector, or marketplace work can be considered.

This document does not implement `V5-IMPL-2D`. It only defines what a later
implementation PR may and may not do.

## Baseline

The scope starts from these sealed checkpoints:

- `V5-IMPL-2C_CLOSEOUT_AUDIT_GREEN`
- `CODE-SETTLE-0_GREEN`
- `main @ 34b8844a51268618e4d8508d5abfc46e366fb2b3`

## Position in the V5 chain

- `V5-IMPL-2A`: Shared Trust Package base shape
- `V5-IMPL-2B`: Route Receipt / Reasoning Metadata extension
- `V5-IMPL-2C`: Shared Trust Package validator helper and tests
- `V5-IMPL-2D`: Shared Trust Package conformance readiness scope
- Later gates: runtime writer, runtime reader, package verification, A2A exchange, connector enforcement, marketplace

## Why 2D exists

The validator added in `V5-IMPL-2C` proves that the current fixture/schema
subset can be checked deterministically. It does not prove that the wider
Shared Trust Package line is ready for runtime exchange, package persistence,
signing, verification, or connector use.

`V5-IMPL-2D` exists to define the readiness evidence needed between the
validator helper and any future runtime gate.

## Allowed future 2D implementation scope

A later implementation PR may choose one narrow conformance-readiness artifact,
such as:

- a conformance readiness checklist
- a package contract coverage matrix
- a fixture-to-schema-to-validator mapping
- an explicit non-runtime readiness test plan
- a gap list for a future `V5-IMPL-2E` or runtime gate

Any future implementation must remain machine-readable or testable where
possible, but it must not add runtime behavior.

## Forbidden 2D scope

`V5-IMPL-2D` must not implement or modify:

- Trust Package runtime writer
- Trust Package runtime reader
- signing runtime
- verification runtime
- A2A transport
- connector enforcement
- marketplace
- AgentAction policy engine
- dashboard/UI
- package dependencies
- `kernel.js`
- `server.js`
- `mcpServer.js`
- `graph.js`
- `lib/**`
- runtime persistence or memory behavior

## Required non-claims

After `V5-IMPL-2D`, do not claim:

- V5 is complete.
- Shared Trust Package runtime exchange is implemented.
- Package signing runtime is implemented.
- Package verification runtime is implemented.
- A2A trust exchange is implemented.
- Connector enforcement is implemented.
- Marketplace is implemented.
- 2D creates production-ready ecosystem behavior.

## Exit criteria for this docs PR

This scope-definition PR is complete only if:

- only `docs/v5/v5-impl-2d-scope-definition.md` changes
- no runtime files change
- no schema, helper, fixture, or test files change
- no package files change
- `git diff --check` passes
- `git status --short` is clean after commit
- no broad product claims are added

## Proposed next gate

The next review gate for this docs-only PR is:

`V5-IMPL-2D_SCOPE_DEFINITION_READY_FOR_READ_ONLY_REVIEW`

## Recommended later follow-up

Only after this scope definition is reviewed, merged, and smoked should the
next implementation decision be made.

The likely implementation candidate is:

`V5-IMPL-2D_CONFORMANCE_READINESS_MATRIX`

If review finds a better narrow next step, choose that later gate explicitly
instead of widening this PR.
