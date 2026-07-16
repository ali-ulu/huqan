# REFACTOR-1 Public Kernel Seam Scope Definition

## Purpose

Define the scope for the first mechanical public Kernel seam refactor after
`REFACTOR-0C_KERNEL_FACADE_CONTRACT`.

This task-pack does not implement the seam. It defines what a future
implementation may and may not change so that public consumers continue to see
the same Kernel facade while internal entry-point ownership becomes explicit.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base: `153a9ea15d225b229be5469359572eee22240941`
- Previous checkpoint: `REFACTOR-0C_CLOSEOUT_AUDIT_GREEN`
- Authorized successor: `REFACTOR-1_PUBLIC_KERNEL_SEAM_IMPLEMENTATION`

The scope-definition base records the source state against which this
task-pack was authored. It is not the future implementation base.

The future implementation may begin only from the exact post-merge canonical
`main` SHA supplied in a separate implementation authorization after this
task-pack has been merged. Before implementation, the checked-out branch must
be `main`, `HEAD` must equal `origin/main`, `HEAD` must equal that separately
authorized implementation base, and this task-pack must exist unchanged at
that base. Otherwise stop with `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`.

## Current Contract Source

`REFACTOR-0C` established the current public Kernel contract in:

- `docs/refactor/kernel-facade-contract.md`
- `test/kernel-facade-contract.test.js`

The future `REFACTOR-1` implementation must preserve that contract unless a
separate gate explicitly changes it.

## Public Kernel Seam

The canonical public Kernel entry must remain:

- package entry: `require('..')`
- library file: `kernel.js`
- type surface: `kernel.d.ts`
- CLI entry: `cli.js`

The future seam may introduce an internal adapter or facade module only if:

- `require('..')` still resolves to the same public Kernel constructor;
- `kernel.js` remains the package library entry point;
- public method names and result shapes remain unchanged;
- `kernel.d.ts` continues to describe the public runtime surface accurately;
- existing contract tests and full suite remain green.

## Frozen Compatibility Invariants

The future implementation must preserve:

- `require('..') === require('./kernel')`
- high-level facade methods listed by `test/kernel-facade-contract.test.js`
- `Kernel.CONTRACT_VERSION`
- `Kernel.AXIOM_ERROR`
- instance `contractVersion`
- observable `graph` compatibility surface
- observable `memory` compatibility surface
- current verdict, receipt, and envelope behavior
- current CLI entry behavior
- current MCP behavior

`graph` and `memory` remain compatibility surfaces, not newly blessed stable
mutation APIs. This gate does not authorize changing their ownership,
serialization, lifecycle, or mutation semantics.

## Future Implementation Boundaries

The future implementation may be a narrow mechanical change limited to public
Kernel seam clarity. Acceptable implementation strategies include:

- adding one internal seam module that re-exports or wraps the existing Kernel
  constructor without behavior change;
- updating package-facing wiring only when package entry identity remains
  unchanged;
- adding or extending contract tests that prove public facade equivalence.

The implementation must not split the monolith broadly. It must not move
business logic, graph ownership, memory ownership, MCP behavior, CLI behavior,
or V5 runtime logic.

## Allowed Future Implementation Files

The future implementation may touch only the files named in its separate
implementation authorization. The default candidate set is:

- `kernel.js`
- one new internal seam module under `lib/`
- `test/kernel-facade-contract.test.js`
- one additional focused seam contract test, if needed

Any need to touch `kernel.d.ts`, `package.json`, `cli.js`, `mcpServer.js`,
`graph.js`, memory-store files, V5 files, schemas, fixtures, or workflows must
stop and open a narrower scope update.

## Forbidden In This Scope-Definition Gate

This docs-only gate does not authorize:

- `kernel.js` changes;
- `kernel.d.ts` changes;
- runtime implementation;
- method rename, removal, or signature change;
- verdict, receipt, or envelope behavior changes;
- graph ownership changes;
- memory ownership changes;
- MCP changes;
- CLI changes;
- V5 changes;
- schema, fixture, or package changes;
- dependency changes;
- Policy Auditor implementation;
- broad module extraction;
- branch, tag, or repository setting changes.

## Acceptance Tests For Future Implementation

The future implementation must run:

```bash
node --test test/kernel-facade-contract.test.js
npm test
git diff --check
git status --short
```

If a new seam-specific contract test is added, it must be run together with the
existing facade contract test.

The expected post-implementation result is:

- targeted facade/seam tests pass;
- full suite has `0 fail`;
- changed files match the separately authorized implementation scope exactly;
- `kernel.d.ts` still matches runtime behavior;
- package entry identity remains stable;
- no new runtime capability is claimed.

## Stop Conditions

Stop with a blocker if:

- `require('..')` no longer resolves to the public Kernel constructor;
- `require('..') === require('./kernel')` cannot be preserved;
- `kernel.d.ts` must change to make the seam correct;
- a public method must be renamed, removed, or retyped;
- result envelopes, receipts, or verdicts would change;
- graph or memory ownership must change;
- MCP or CLI behavior must change;
- a package or dependency change is needed;
- V5 runtime, fixture, or schema files need to change;
- Policy Auditor code becomes necessary;
- full suite fails after the narrow implementation.

Use the most specific blocker:

- `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`
- `BLOCKED_BY_PUBLIC_ENTRY_IDENTITY_CONFLICT`
- `BLOCKED_BY_TYPE_SURFACE_ALIGNMENT_GAP`
- `BLOCKED_BY_RUNTIME_BEHAVIOR_DRIFT`
- `BLOCKED_BY_SCOPE_DRIFT`

## Non-Claims

This task-pack does not claim:

- Kernel has been refactored;
- the monolith has been split;
- public seam implementation exists;
- graph or memory ownership has changed;
- runtime behavior is improved;
- Policy Auditor is authorized or implemented.

## Hard Stop

Even after this task-pack is merged, do not begin `REFACTOR-1` implementation
automatically. Do not edit runtime files, open a broad refactor, or start
Policy Auditor without separate authorization.

## Required Final Report

The future implementation report must include:

```text
PLAN CHECK:
1. Previous checkpoint:
2. Repository:
3. Canonical base:
4. Branch:
5. Changed files:
6. Next gate:

PUBLIC ENTRY:
TYPE SURFACE:
FACADE METHODS:
GRAPH/MEMORY COMPATIBILITY:
RUNTIME BEHAVIOR:
TARGETED TESTS:
FULL SUITE:
DIFF CHECK:
WORKTREE:
COMMIT:
PUSH:
PR:

BLOCKING FINDINGS:
NON-BLOCKING FINDINGS:
FINAL VERDICT:
```
