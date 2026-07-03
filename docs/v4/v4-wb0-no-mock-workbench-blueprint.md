# HUQAN / AXIOM V4-WB0 No-Mock Workbench / Trust Runtime Blueprint

## Current checkpoint

```txt
V4_RUNTIME_SURFACE_CLOSEOUT_GREEN
Canonical HEAD: 22ab845882b1d832de9ef9c395f3ff1da43e29df
```

V4-WB0 starts from the closed V4 runtime surface chain. It defines the rules for
a future human-facing Workbench / Trust Runtime surface. It does not implement a
UI, dashboard, runtime behavior, PR6 demo pack, V5 readiness, or marketplace
work.

## Purpose

V4-WB0 defines the rules for building a human-facing Workbench on top of real
HUQAN runtime surfaces.

The Workbench must not become a fake dashboard. It must not show hardcoded
verdicts, fake receipts, fake graph state, fake memory admission, or mock trust
decisions as product behavior.

This document is a blueprint and claim boundary. It is not an implementation
PR.

## Product boundary

The Workbench is defined as:

```txt
A read-only trust inspection surface that exposes real HUQAN verdicts,
receipts, tool decisions, memory admission state, and context integrity evidence.
```

The Workbench must start as read-only:

- no approve/reject mutation
- no memory mutation
- no action execution
- no auto-fix
- no self-healer
- no marketplace

Any future mutation or approval surface must be separately scoped, reviewed, and
validated. It cannot be implied by this blueprint.

## Real runtime surfaces available

The following V4 runtime surfaces are closed and available as real sources for
future read-only inspection:

- verdict reconciliation
- Trust Receipt primitive
- receipt read-index
- Trust Receipt read API
- MCP toolVerdict
- memoryAdmission
- contextIntegrity

These surfaces define what a future Workbench may inspect. They do not authorize
mock data or product claims beyond tested runtime paths.

## No-mock rule

A Workbench surface counts as product surface only if it is connected to real
runtime outputs.

Mock paths may exist only when explicitly labeled as mock/demo. Mock data must
not be used in production, pitch, investor, release, or readiness claims.

Forbidden mock claims:

- fake allow/review/block decisions
- fake Trust Receipt ids
- fake memory admission state
- fake workspace integrity
- fake graph proof
- fake connector coverage
- fake Workbench readiness

If a surface cannot reach real runtime data, it must say so explicitly and fail
closed as unavailable, unsupported, or deferred. It must not fill the gap with
invented product evidence.

## Read-only inspector sequence

The recommended sequence after WB0 is:

```txt
V4-WB1 - Trust Receipt / Verdict Inspector, read-only
V4-WB2 - Memory Admission / Context Integrity Inspector, read-only
V4-WB3 - MCP Tool Verdict Inspector, read-only
V4-WB4 - Reasoning Trace / Evidence Inspector, read-only if real runtime source exists
V4-PR6 - Demo / Evidence Pack before V5
V5-READINESS-0 - readiness audit only after WB inspectors and PR6
```

Each inspector PR must remain narrow. No inspector PR may silently add mutation,
approval execution, auto-fix, or demo-only fake state.

## V4-WB1 definition

Goal:

```txt
Read and display real Trust Receipt and verdict surfaces.
```

Allowed future source surfaces:

- PR3 Trust Receipt read API
- PR2 / PR2.5 / PR2.6 receipt chain
- PR4 toolVerdict if applicable

Required constraints:

- read-only
- must not create receipts
- must not mutate memory
- must not execute tools
- must not fabricate receipt ids
- must not mark unknown receipts as verified

## V4-WB2 definition

Goal:

```txt
Read and display memoryAdmission and contextIntegrity state.
```

Allowed future source surfaces:

- PR5 memoryAdmission
- PR5 contextIntegrity

Required constraints:

- read-only
- must not approve memory
- must not reject memory
- must not mutate canonical memory
- must not claim all kernel writes are structurally impossible without admission
- must not invent provenance, workspace integrity, or canonical mutation state

## V4-WB3 definition

Goal:

```txt
Read and display MCP toolVerdict decisions.
```

Allowed future source surfaces:

- PR4 MCP toolVerdict

The inspector must show real fields when available:

- tool
- verdict
- reason
- receiptId if real
- traceId if real
- workspaceId if real

Required constraints:

- read-only
- must not execute new tools
- must not create synthetic verdicts
- must not convert demo values into product claims

## V4-WB4 definition

Goal:

```txt
Expose reasoning trace / evidence only when a real runtime source exists.
```

If a real trace/evidence source is unavailable, WB4 must remain
blueprint/deferred.

Required constraints:

- no fake reasoning trace
- no fake evidence list
- no fabricated graph proof
- no hallucination-elimination claim
- no truth-guarantee claim

WB4 may proceed only after a real runtime source is identified and scoped.

## Non-claims

This blueprint does not claim:

- Workbench is implemented
- UI exists
- production enterprise control plane is ready
- all connector/client paths are covered
- all unsafe actions are prevented
- all kernel writes are structurally impossible without admission
- HUQAN guarantees truth
- HUQAN eliminates hallucinations
- V5 is ready
- marketplace/badge/conformance is ready

## Product language

Safe language:

```txt
HUQAN Workbench will expose tested runtime trust surfaces for inspection:
verdicts, receipts, MCP tool decisions, memory admission, and context integrity.
```

Unsafe language:

```txt
HUQAN Workbench controls all agents.
HUQAN prevents all unsafe actions.
HUQAN guarantees truth.
HUQAN is enterprise production-ready.
HUQAN covers every connector path.
```

Product language must remain evidence-backed. If a claim is not backed by a real
runtime surface and test evidence, it must be removed or explicitly labeled as a
future goal.

## Validation evidence

Latest known V4 closeout:

```txt
V4 runtime surface closeout:
- PR2 through PR5 closed
- PR6 deferred before V5
- npm test: 1654 tests / 1625 pass / 0 fail / 29 skipped
- no Workbench implementation yet
```

Validation commands for this docs-only blueprint:

```bash
npm ci
npm test
git diff --name-only 22ab845882b1d832de9ef9c395f3ff1da43e29df..HEAD
git status --short
```

Expected:

- `npm ci` pass
- `npm test` pass
- changed files remain docs-only
- no runtime/test/package/UI files changed
- `git status --short` clean after commit

## Final WB0 statement

V4-WB0 authorizes only a no-mock, real-runtime, read-only Workbench blueprint.

It does not authorize Workbench implementation, PR6 demo work, V5 readiness,
marketplace, badges, conformance programs, agent customs, self-healer, or public
release claims.
