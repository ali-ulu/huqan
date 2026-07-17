# REFACTOR-1C2 Kernel Lifecycle and Maintenance Seam Scope

## Purpose

Define the minimum behavior-preserving Kernel facade contract needed to remove
the CLI's direct lifecycle and maintenance calls through `kernel.graph`. This
task-pack freezes source reality, exact proposed method contracts, test
ownership, and successor boundaries. It does not implement a runtime method,
change a type, migrate the CLI, or add a test.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch before this scope gate: `main`
- Scope-definition base:
  `aed1af973ecc7ec774a7748c2ef02b4c73626e8b`
- Previous checkpoint: `REFACTOR-1C1A_CLOSEOUT_AUDIT_GREEN`
- Current gate:
  `REFACTOR-1C2_KERNEL_LIFECYCLE_AND_MAINTENANCE_SEAM_SCOPE`

The scope-definition base records the source used to author this contract. It
does not authorize a successor implementation. Every successor must receive a
separate exact canonical `main` base after its predecessor is reviewed,
merged, and closed.

## Governing Sources

- `docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md`
- `docs/task-packs/refactor-1c1-cli-graph-read-contract-test-scope.md`
- `docs/refactor/kernel-facade-contract.md`
- `cli.js`
- `cli.test.js`
- `kernel.js`
- `kernel.d.ts`
- `kernel.v2.js`
- `graph.js`
- `graph.test.js`
- `kernel.test.js`
- `backupRestore.js`
- `persistencePaths.js`
- `test/kernel-facade-contract.test.js`
- `test/kernel-constructor-variant-contract.test.js`

## Governing Invariants

- Runtime and CLI behavior remain unchanged.
- Kernel v1 remains the default package and CLI constructor.
- Explicit KernelV2 selection remains unchanged.
- Existing synchronous completion and error behavior remain unchanged.
- Existing persistence formats, workspace semantics, command text, and
  ordering remain unchanged.
- No seam returns the Graph instance, MemoryStore, SQLite handle, prepared
  statement, `_nodes`, `_edges`, or another mutable internal collection.
- Independent `KernelOptions.dbPath` support is not added to CLI backup or
  restore behavior.
- `selfEvolve()` is not an optimize replacement.
- Server and MCP graph coupling remain outside this CLI-focused sequence.

## Source Reality

### Constructor load

`kernel.js:63-72` currently performs this synchronous sequence:

```text
build Graph options
-> construct Graph
-> call graph.load() unless opts.noLoad is truthy
-> initialize the remaining Kernel components
```

`noLoad` skips only the constructor's explicit `graph.load()` call. It does
not skip Graph construction, MemoryStore construction, plugin setup, or other
Kernel initialization. If `noLoad` is the only persistence-related option,
Kernel also defaults Graph SQLite usage off for that construction.

`Graph.load()` is synchronous and returns `undefined`. It resets graph
collections and indexes before reading persistence. It attempts SQLite first.
If SQLite contains graph state, it rebuilds the in-memory graph and returns.
SQLite read errors are logged and fall through to JSON. JSON absence returns
without error. JSON parse/load errors are logged and swallowed. A successful
JSON load with an active SQLite backend invokes `save()` to migrate state into
SQLite. Therefore load includes possible migration and persistence side
effects; it is not a pure read.

### Startup duplicate load

The executable CLI path currently performs:

```text
new CLI()
-> new Kernel()
-> constructor graph.load() when noLoad is false
-> cli.kernel.graph.load()
-> cli.start()
```

The second call resets collections again. Depending on available persistence,
the first call may also migrate JSON data into SQLite before the second call
selects its source. Existing tests do not prove that removing the explicit
startup load is behavior-equivalent across JSON, SQLite, migration, missing
files, and load-error paths.

Decision: **C - evidence is insufficient; no duplicate-load removal decision
is allowed without a separate behavior-analysis and contract-test gate.**

The explicit startup load must remain during the mechanical migration unless
a separately authorized gate proves that it can be removed. This task-pack
does not change startup code.

### Persistence descriptor

`CLI._backupOptions()` currently reads `kernel.graph.memoryPath`, falling back
to `memory.json`, derives a database path by replacing a trailing `.json`
case-insensitively with `.db`, and then passes both values to
`resolvePersistencePaths()` using the current working directory.

Kernel accepts `KernelOptions.dbPath`, but Graph does not expose that selected
value as a compatibility property and `_backupOptions()` does not read it.
Independent `dbPath` support remains deferred to:

```text
PERSISTENCE-PATH-ALIGNMENT
```

### Reload after restore

The CLI restore path currently performs:

```text
restoreBackup(_backupOptions(...))
-> kernel.graph.load()
-> return the restore success message
```

The reload finishes synchronously before success is returned. Reload resets
in-memory collections, uses the SQLite-first/JSON-fallback behavior described
above, may perform JSON-to-SQLite migration, returns `undefined`, and keeps
Graph's existing logged-and-swallowed load-error behavior.

### Persist on save and exit

Interactive `kaydet` and `exit` currently call `graph.save()` synchronously
before printing success text. `Graph.save()`:

1. prunes the default workspace using the configured threshold;
2. temporarily strips embeddings from in-memory nodes;
3. writes nodes, edges, candidate claims, and audit events in a SQLite
   transaction when SQLite is active;
4. writes the JSON fallback representation;
5. restores embeddings in memory;
6. writes an embeddings file when embeddings exist;
7. returns `undefined`.

`save()` does not catch its write or transaction errors, so those errors
propagate and prevent the subsequent CLI success message or exit close path.
The seam must not close graph or memory resources before persistence. It must
not add MemoryStore persistence or another save call.

### Optimize and maintenance

`Graph.optimize(workspaceId = 'default')` is synchronous. It prunes weak edges
in the selected workspace, computes time-based node decay using `Date.now()`,
removes sufficiently decayed isolated nodes, applies corresponding SQLite
deletes when active, and returns exactly:

```text
{ pruned, removedNodes }
```

The CLI calls it with no argument and prints:

```text
Optimize: <pruned> kenar budandi, <removedNodes> dugum silindi.
```

It does not save, dream, consolidate, or emit the broader `selfEvolve()`
workflow. Uncaught optimize errors propagate. `selfEvolve()` performs
additional behavior and is explicitly forbidden as the implementation of the
narrow maintenance intent.

## Exact Proposed Contracts

The names below follow the existing Kernel facade style: intent-level verbs
for operations and a descriptive `get...` name for immutable configuration.
They avoid a generic dispatcher or a Graph escape hatch.

| Field | Persistence descriptor | Reload intent | Persist intent | Optimize intent |
| --- | --- | --- | --- | --- |
| Proposed method name | `getPersistenceDescriptor` | `reload` | `persist` | `optimize` |
| Kernel v1 | Build a fresh frozen descriptor from current Graph `memoryPath` semantics | Delegate once to `graph.load()` | Delegate once to `graph.save()` | Delegate once to `graph.optimize()` |
| KernelV2 | Delegate to wrapped Kernel v1 method; no independent behavior | Delegate to wrapped Kernel v1 method | Delegate to wrapped Kernel v1 method | Delegate to wrapped Kernel v1 method |
| Parameters | none | none | none | none |
| Return value | `Readonly<{ memoryPath: string, dbPath: string }>` | `void` / current `undefined` | `void` / current `undefined` | exact `{ pruned: number, removedNodes: number }` |
| Sync/async | synchronous | synchronous | synchronous | synchronous |
| Errors | no new I/O; ordinary programming errors propagate | preserve Graph load logging/swallow/fallback behavior | preserve uncaught Graph save errors | preserve uncaught Graph optimize errors |
| Side effects | allocate and freeze a new plain object only | reset and reload graph; preserve possible JSON-to-SQLite migration | preserve prune, SQLite, JSON, and embedding side effects | preserve default-workspace prune, time-based decay, node removal, and SQLite deletes |
| Forbidden side effects | no I/O, no live object alias, no independent `dbPath` | no extra load, save, close, audit, or format change | no extra save, close, MemoryStore write, audit, or success handling | no save, dream, consolidate, audit, or self-evolution |
| CLI owner | `_backupOptions()` for backup and restore | restore path and, later, explicit startup load migration | interactive `kaydet` and exit | `optimize` command |
| Test owner | `cli.test.js` plus a future Kernel seam contract test | Graph persistence tests, CLI restore test, and future Kernel seam contract test | Graph persistence tests, CLI interactive ordering tests, and future Kernel seam contract test | `graph.test.js`, CLI command test, and future Kernel seam contract test |
| Type surface | add exact read-only descriptor return | add `reload(): void` | add `persist(): void` | add exact optimize result type |
| Migration gate | `REFACTOR-1C2C` then CLI use in `REFACTOR-1C2D` | `REFACTOR-1C2C` then CLI use in `REFACTOR-1C2D` | `REFACTOR-1C2C` then CLI use in `REFACTOR-1C2D` | `REFACTOR-1C2C` then CLI use in `REFACTOR-1C2D` |

### `getPersistenceDescriptor()`

Exact future contract:

```typescript
getPersistenceDescriptor(): Readonly<{
  memoryPath: string;
  dbPath: string;
}>;
```

- `memoryPath` is the current Graph `memoryPath`, including its current
  relative-versus-absolute form, with the existing `memory.json` fallback.
- `dbPath` is derived from that `memoryPath` using the current CLI rule:
  replace a trailing `.json`, case-insensitively, with `.db`.
- The descriptor is a newly allocated plain object on every call and is
  frozen before return.
- It does not expose or retain a Graph, MemoryStore, database, statement,
  collection, or mutable object reference.
- It does not report the independently configured `KernelOptions.dbPath`.
- Path resolution against `process.cwd()` remains owned by the existing
  `resolvePersistencePaths()` call in the CLI migration.

### `reload()`

Exact future contract:

```typescript
reload(): void;
```

- Calls the current Graph load operation exactly once per intent invocation.
- Returns only after the restored state is visible through the current graph
  compatibility surface.
- Preserves reset, SQLite-first, JSON-fallback, embedding, migration, logging,
  swallowed load errors, and `undefined` return behavior.
- Does not interpret success, produce CLI text, or add a second load.

### `persist()`

Exact future contract:

```typescript
persist(): void;
```

- Calls the current Graph save operation exactly once per intent invocation.
- Completes before returning and preserves current `undefined` return.
- Preserves default-workspace prune, SQLite transaction, JSON fallback,
  embedding restoration/write, and error propagation.
- Does not close resources, print success, write MemoryStore state, or call
  save a second time.

### `optimize()`

Exact future contract:

```typescript
optimize(): {
  pruned: number;
  removedNodes: number;
};
```

- Calls `graph.optimize()` with no workspace argument, preserving the default
  workspace behavior.
- Returns the exact current result object shape without wrapping or renaming.
- Preserves synchronous mutation and uncaught error propagation.
- Does not call `selfEvolve()`, save, dream, consolidate, or add audit work.

## KernelV2 Disposition

KernelV2 wraps a Kernel v1 instance and already exposes its Graph through a
compatibility getter. Future lifecycle methods must delegate to the wrapped
Kernel methods, not duplicate Graph logic or call `this.graph` independently.
The constructor selector, wrapper identity, and v2 learn/verify behavior must
remain unchanged. KernelV2 runtime delegation and its contract tests belong to
the separately authorized implementation sequence.

## Test Ownership Map

| Behavior | Current owner/evidence | Missing evidence | Future owner | Timing |
| --- | --- | --- | --- | --- |
| Constructor auto-load | Kernel source and Graph persistence tests indirectly exercise load | exact one-call behavior and source visibility across JSON/SQLite | future dedicated Kernel lifecycle contract test | before runtime seam implementation |
| Explicit `noLoad` | constructor-variant helpers construct with `noLoad` | direct proof that load is skipped without changing other initialization | future dedicated Kernel lifecycle contract test | before runtime seam implementation |
| Restore reload visibility | `cli.test.js` backup/restore round trip | Kernel `reload()` delegation, return, and error semantics | `cli.test.js` plus lifecycle contract test | before and after CLI migration |
| `kaydet` persist ordering | CLI source | exact once-only call, completion before message, propagated error | `cli.test.js` | before and after CLI migration |
| Exit persist ordering | CLI source | exact once-only call, completion before message/close, propagated error | `cli.test.js` | before and after CLI migration |
| Persist side effects | `graph.test.js` save/load cases | Kernel delegation plus return and error parity | Graph tests plus lifecycle contract test | before runtime seam implementation |
| Optimize result shape | `graph.test.js` | Kernel delegation, no extra side effects, exact CLI text | Graph tests, lifecycle contract test, and `cli.test.js` | before and after CLI migration |
| No `selfEvolve()` side effect | source comparison only | executable rejection of dream/consolidate/save additions | lifecycle contract test | before runtime seam implementation |
| Kernel v1 default | constructor-variant contract test | lifecycle methods on v1 facade | lifecycle contract test | before runtime seam implementation |
| Explicit KernelV2 selection | constructor-variant contract test | delegation parity for all four seams | lifecycle contract test | with runtime seam implementation |
| Facade/type parity | kernel facade contract test and `kernel.d.ts` | exact four new declarations and runtime functions | facade contract test | with runtime seam implementation |
| Startup duplicate load | source proves two calls | behavior equivalence across persistence modes and errors | separate startup load behavior-analysis tests | separate gate; not decided here |

The preferred new owner for direct seam behavior is one narrow file:

```text
test/kernel-lifecycle-maintenance-seam-contract.test.js
```

Existing Graph and CLI tests should be strengthened only where they already
own the observable behavior. Constructor selector tests are rerun, not copied.

## Successor Gate Decomposition

No successor is authorized by this task-pack. Subject to separate exact-base
approval, use this sequence:

### REFACTOR-1C2A Lifecycle and maintenance contract test scope

- Freeze exact test ownership, fixtures, spies, persistence modes, ordering,
  and negative side-effect assertions.
- Resolve whether constructor auto-load and startup duplicate-load analysis
  need a separate sub-gate.
- Docs/task-pack only.

### REFACTOR-1C2B Lifecycle and maintenance contract tests

- Add tests for current Graph behavior and the future seam contract boundary.
- Do not implement runtime seams in the test gate.
- Stop if executable tests require behavior changes rather than contract
  preservation.

### REFACTOR-1C2C Kernel type/runtime seam implementation

- Implement only the four exact methods in Kernel v1, KernelV2 delegation,
  and the aligned declaration surface.
- No CLI callsite migration.
- Preserve all return, error, ordering, and side-effect contracts.

### REFACTOR-1C2D CLI lifecycle and maintenance migration

- Replace only the inventoried `_backupOptions()`, restore, interactive save,
  exit, and optimize direct Graph accesses with the approved seams.
- Preserve command output and call ordering.
- Keep explicit startup duplicate load unless a separate analysis gate has
  already authorized its removal.

### REFACTOR-1C2E Source-boundary and closeout

- Prove the migrated CLI paths no longer use direct Graph lifecycle or
  maintenance calls.
- Rerun targeted lifecycle, CLI, facade, constructor-variant, persistence,
  security, benchmark, Docker, and full-suite validation.
- Record remaining status and audit coupling without starting those gates.

## Allowed Scope for This Gate

Only:

```text
docs/task-packs/refactor-1c2-kernel-lifecycle-maintenance-seam-scope.md
```

## Forbidden Scope for This Gate

- `cli.js` or `cli.test.js`
- `kernel.js`, `kernel.d.ts`, or `kernel.v2.js`
- `graph.js`, `graph.test.js`, or `kernel.test.js`
- `backupRestore.js` or `persistencePaths.js`
- any runtime or test implementation
- package, lockfile, dependency, workflow, Docker, fixture, or schema changes
- server or MCP migration
- Graph or MemoryStore redesign
- independent `dbPath` support
- audit or status migration
- V5, Policy Auditor, Self-Healer, or product work
- automatic merge or automatic successor start

## Acceptance Criteria

- Exact source-definition base is recorded.
- Only lifecycle and maintenance couplings from REFACTOR-1C are addressed.
- Constructor and startup duplicate-load reality are explicit.
- Duplicate-load removal is deferred because evidence is insufficient.
- The persistence descriptor is exact, minimum, fresh, and frozen.
- Independent `dbPath` behavior remains deferred.
- Reload, persist, and optimize names, signatures, returns, errors, ordering,
  and side effects are exact.
- Save prune, SQLite, JSON, and embedding effects are explicit.
- Optimize result shape and the prohibition on `selfEvolve()` are explicit.
- KernelV2 delegation is dispositioned without changing constructor behavior.
- Test ownership and successor decomposition are explicit.
- Exactly one task-pack file changes.
- `git diff --check` passes.
- Tests are not run because this gate is docs/task-pack only.

## Stop Conditions

Stop with `REFACTOR-1C2_BLOCKED_SOURCE_CONFLICT` if:

- constructor/load order cannot be verified;
- Graph load, save, or optimize behavior is contradictory or unclear;
- a minimum seam requires returning Graph or mutable internals;
- independent `dbPath`, server, MCP, Graph redesign, or persistence-format
  changes become necessary;
- KernelV2 requires unrelated runtime behavior changes;
- runtime or test edits are required to complete this scope document;
- an existing return, error, workspace, constructor, or persistence contract
  must change.

Stop with `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH` if the exact base, branch,
remote, predecessor, or worktree reality differs from the authorization.

Stop with `BLOCKED_BY_SCOPE_DRIFT` if any path outside the allowed task-pack
changes.

## Non-Claims

- No Kernel lifecycle or maintenance method has been added.
- No KernelV2 delegation has been added.
- No declaration or public runtime surface has changed.
- No CLI direct Graph access has been removed.
- No constructor or startup load behavior has changed.
- No duplicate-load equivalence has been established.
- No persistence path, format, workspace, prune, embedding, or error behavior
  has changed.
- No server, MCP, audit, status, V5, Policy Auditor, or Self-Healer work has
  started.
- The refactor program is not complete.

## Validation

```powershell
git diff --name-only `
  aed1af973ecc7ec774a7748c2ef02b4c73626e8b..HEAD

git diff --check `
  aed1af973ecc7ec7748c2ef02b4c73626e8b..HEAD

git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1c2-kernel-lifecycle-maintenance-seam-scope.md
```

Tests are not run because this gate adds a docs/task-pack file only.

## Commit and Review Lifecycle

Commit message:

```text
docs: define Kernel lifecycle maintenance seam scope
```

Push the dedicated branch and open a draft PR. Do not merge and do not start a
successor automatically.

## Success Verdict

```text
REFACTOR-1C2_KERNEL_LIFECYCLE_AND_MAINTENANCE_SEAM_SCOPE_READY_FOR_READ_ONLY_REVIEW
```
