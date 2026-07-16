# REFACTOR-1A0 Kernel Type-Surface Alignment Scope

## Purpose

Define the narrow type-only correction required before the public Kernel seam
contract-test scope can continue.

Runtime exposes `kernel.memory` as an observable compatibility surface, while
`kernel.d.ts` does not currently declare that property. This task-pack records
the source reality and authorizes no implementation by itself.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base: `2fb549048e7a874c67847702084330369ed0f564`
- Previous checkpoint: `REFACTOR-1A_BLOCKED_SOURCE_CONFLICT`
- Authorized successor: `REFACTOR-1A1_KERNEL_TYPE_SURFACE_ALIGNMENT`

The scope-definition base records the source state against which this
task-pack was authored. It is not the future implementation base.

The future alignment implementation may begin only from the exact post-merge
canonical `main` SHA supplied in a separate authorization after this task-pack
has been merged. Before implementation, the checked-out branch must be `main`,
`HEAD` must equal `origin/main`, `HEAD` must equal that separately authorized
implementation base, and this task-pack must exist unchanged at that base.
Otherwise stop with `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`.

## Runtime Memory Findings

The current source establishes the following runtime facts:

- `kernel.js:96` assigns `this.memory = new MemoryStore(...)` during Kernel
  construction.
- The assignment is not guarded by a feature flag or optional branch. Every
  successfully constructed Kernel instance receives a memory store.
- `kernel.js:98` maps `memoryStoreUseSQLite`, when supplied, to the memory-store
  `useSQLite` option; otherwise it inherits the Kernel `useSQLite` option.
- `memoryStoreDbPath` and `memoryStorePath` select persistence paths without
  changing the presence of the `memory` property.
- `lib/memory-store.js:149` defines the concrete `MemoryStore` class assigned
  to `kernel.memory`.
- `lib/memory-store.js:1361` defines `MemoryStore.close()` as a class method.
  The method exists for both in-memory and SQLite-backed instances; it closes
  the database only when one is open.
- `kernel.js:104-111` wraps `graph.close()` so Kernel shutdown also calls
  `memory.close()` when available.
- `test/kernel-facade-contract.test.js:73-74` already verifies that
  `kernel.memory` is observable and `kernel.memory.close` is callable.

The supported persistence configuration changes storage behavior, not the
minimum observable memory compatibility surface. No source evidence requires
exposing persistence internals through the public Kernel type.

## Current Type-Surface Findings

The current declaration source establishes:

- `package.json:5-6` maps the package entry to `kernel.js` and its type surface
  to `kernel.d.ts`.
- `kernel.d.ts:91` declares the public Kernel class.
- `kernel.d.ts:92-93` declares `AXIOM_ERROR` and `CONTRACT_VERSION`.
- `kernel.d.ts:97-101` declares the observable `graph` surface with
  `memoryPath`, `load()`, and `save()`.
- `kernel.d.ts` does not declare a `memory` property.
- The repository contains no reusable `MemoryStore` interface or declaration
  file. `lib/memory-store.js` is an internal CommonJS implementation module.

The omission is a type-surface alignment gap. It does not imply a runtime
absence and must not be repaired by changing runtime behavior.

## Public Compatibility Decision

The alignment decision is:

```text
kernel.memory is an observable compatibility surface.
```

This does not establish all `MemoryStore` methods, storage fields, database
handles, serialization details, or mutation behavior as a stable public
extension API.

The minimum declaration is:

```ts
memory: {
  close(): void;
};
```

This shape matches the already frozen runtime observation and exposes no
unsupported internal capability. A broad `MemoryStore` public interface must
not be introduced in this alignment gate.

## Graph And Memory Alignment

Both instance properties remain compatibility surfaces under the same policy:

| Property | Observable | Direct mutation recommended | Stable internal implementation |
| --- | --- | --- | --- |
| `graph` | yes | no | not guaranteed |
| `memory` | yes | no | not guaranteed |

The existing `graph` declaration must remain unchanged. This gate does not
make the two declarations structurally identical; it adds only the smallest
runtime-proven `memory` capability needed to remove the current mismatch.

## Future Implementation Scope

The separately authorized `REFACTOR-1A1_KERNEL_TYPE_SURFACE_ALIGNMENT` gate
must change exactly:

```text
kernel.d.ts
```

It must add only the minimum `memory.close()` declaration shown above.

`test/kernel-facade-contract.test.js` must not change in the default
implementation scope because it already verifies the runtime property and
callable `close()` method. The existing test must be rerun as evidence.

The repository has no TypeScript compile/typecheck command or TypeScript
dependency dedicated to declaration validation. This gate must not add a
dependency, package script, generated declaration, or source-parsing test to
manufacture one.

If implementation review demonstrates that declaration syntax cannot be
validated without a new dependency or a second changed file, stop and request
a separate scope decision.

## Acceptance Criteria

The future alignment implementation must prove:

- `kernel.d.ts` declares `kernel.memory`;
- the declaration contains callable `close(): void`;
- no unsupported `MemoryStore` internals are exposed;
- the existing `graph` declaration remains byte-for-byte unchanged;
- `kernel.js`, `lib/memory-store.js`, and all other runtime files remain
  unchanged;
- package entry and type-entry metadata remain unchanged;
- `test/kernel-facade-contract.test.js` remains unchanged and passes;
- the full `npm test` suite completes with `0 fail`;
- `git diff --check` passes;
- changed files match the separately authorized implementation scope exactly;
- the worktree is clean after commit.

Required validation for the future implementation:

```bash
node --test test/kernel-facade-contract.test.js
npm test
git diff --check
git diff --name-only origin/main...HEAD
git status --short
```

## Stop Conditions

Do not open or continue the implementation gate if:

- `kernel.memory` becomes conditional or absent in a supported configuration;
- `memory.close()` is not consistently available on successfully constructed
  Kernel instances;
- alignment requires exposing unstable `MemoryStore` internals;
- a package, dependency, script, generated declaration, or typecheck framework
  change is required;
- runtime must change to satisfy the declaration;
- the existing `graph` declaration must change;
- the existing facade contract test requires correction rather than merely
  rerunning;
- any file other than `kernel.d.ts` must change under the default scope;
- targeted or full-suite validation fails.

Use the most specific blocker:

- `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`
- `REFACTOR-1A0_BLOCKED_DEEPER_TYPE_CONFLICT`
- `BLOCKED_BY_TYPE_VALIDATION_INFRASTRUCTURE_GAP`
- `BLOCKED_BY_SCOPE_DRIFT`
- `BLOCKED_BY_BASELINE_TEST_FAILURE`

## Non-Claims

This task-pack does not claim or authorize:

- runtime behavior changes;
- memory ownership changes;
- a `MemoryStore` redesign;
- all `MemoryStore` internals as public API;
- new public methods;
- graph ownership or graph type changes;
- package or dependency changes;
- MCP, CLI, server, schema, fixture, or V5 changes;
- public Kernel seam implementation;
- Policy Auditor work.

No type implementation or test implementation is included in this docs-only
gate.

## Next Gate

After this task-pack is independently reviewed, merged, and closed out, the
next separately authorized gate is:

```text
REFACTOR-1A1_KERNEL_TYPE_SURFACE_ALIGNMENT
```

After `REFACTOR-1A1` is merged and its closeout audit is green, return to:

```text
REFACTOR-1A_PUBLIC_KERNEL_SEAM_TEST_SCOPE
```

Do not start either gate automatically.

## Required Final Report For REFACTOR-1A1

```text
PLAN CHECK:
1. Previous checkpoint:
2. Repository:
3. Canonical base:
4. Branch:
5. Changed files:
6. Next gate:

TYPE DECLARATION:
RUNTIME ALIGNMENT:
GRAPH TYPE PRESERVATION:
TARGETED TEST:
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

## Hard Stop

This scope-definition gate changes documentation only. Do not edit
`kernel.d.ts`, runtime code, tests, package files, MCP, CLI, V5 surfaces, or
Policy Auditor code. Do not begin the type alignment until a separate exact
post-merge implementation base and explicit authorization are supplied.
