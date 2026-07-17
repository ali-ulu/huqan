# REFACTOR-1C CLI Graph Internal Coupling Scope

## Purpose

Define the bounded, behavior-preserving migration scope for direct graph access
in `cli.js`. This task-pack inventories current coupling and assigns future
seams and regression evidence. It does not change runtime code, tests, types,
or graph ownership.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch before implementation: `main`
- Scope-definition base:
  `72786e7cf1e8dd5debf190c48c8a259020e47d5c`
- Previous checkpoint: `REFACTOR-1B_CLOSEOUT_AUDIT_GREEN`
- Current gate: `REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE`

The scope-definition base records the source state used for this inventory. It
is not authorization to implement any seam. A future implementation gate must
name its own exact canonical `main` base after this task-pack is merged and
closed.

## Governing Invariants

- Runtime behavior and CLI output remain unchanged.
- Kernel v1 remains the default package and CLI constructor.
- Explicit KernelV2 selection remains unchanged.
- `graph` and `memory` remain observable compatibility surfaces until a
  separately authorized migration changes that contract.
- Existing graph collections must not become public Kernel API.
- No seam may return mutable `_nodes`, `_edges`, or equivalent live
  collections.
- Existing result, verdict, receipt, audit, persistence, and envelope shapes
  remain unchanged.
- Existing workspace and persistence semantics remain unchanged.

## Source Inventory

The current CLI has seven graph-coupling classes. Repeated calls with the same
intent are grouped together.

| CLI command / path | Current internal access | Read or mutation | Observable behavior | Existing safe replacement | Required new seam | Migration risk | Required regression test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `_backupOptions()` used by `backup` and `restore` | `kernel.graph.memoryPath` | Read configuration | Resolves the memory path from `graph.memoryPath` and derives the database path from that memory path | None outside the current graph compatibility surface | A narrow, immutable Kernel memory-path descriptor or intent-level backup options accessor that preserves the current derivation | A default path or normalization mismatch could back up or restore the wrong files | Preserve the current `memoryPath`-based database-path derivation, default resolution, and backup/restore path selection |
| `restore` and direct CLI startup | `kernel.graph.load()` | Persistence mutation | Reloads the in-memory graph from configured persistence after restore and before interactive use | Kernel construction already loads unless `noLoad`; no public reload intent exists | A narrow Kernel reload lifecycle method; startup must avoid a duplicate load if constructor behavior already provides the same observable state | Double load, stale state, changed error timing, or altered startup behavior | Restore reloads restored content; default startup state and explicit `noLoad` behavior remain unchanged |
| Interactive `kaydet` and exit | `kernel.graph.save()` | Persistence mutation | Prunes and persists graph state before confirmation or process exit | No public Kernel save intent exists | A narrow Kernel persist lifecycle method with the same synchronous completion and error behavior | Save ordering, prune side effects, confirmation timing, or exit behavior could change | `kaydet` and exit persist once, retain messages, and do not close before persistence completes |
| `optimize` | `kernel.graph.optimize()` | Graph mutation | Prunes weak edges and removes decayed isolated nodes; reports `pruned` and `removedNodes` | `selfEvolve()` also optimizes but performs additional unrelated behavior and is not a valid replacement | A narrow intent-level Kernel graph-maintenance method preserving the exact optimize result | Reusing `selfEvolve()` would add dreams, consolidation, audit, and persistence side effects | Exact command result, mutation counts, approval-gate behavior, and no extra self-evolution side effects |
| `durum` | `kernel.graph._nodes` and `kernel.graph._edges` | Read | Reports global node and edge counts | `graph.getStats()` returns `nodes` and `edges` using `nodeCount()` and `edgeCount()` with the same global-count semantics | No collection accessor. First migrate to the existing read-only stats result; a Kernel stats facade requires a separate justification if direct graph compatibility access must also be removed | Workspace filtering or output formatting could accidentally change | Exact global counts and existing `durum` text, entropy, gaps, and contradiction sections |
| `_auditCliMutation()` | `kernel.graph.appendAuditEvent()` | Audit mutation | Appends a CLI mutation audit event and intentionally suppresses audit failures | Kernel has `_appendAuditEvent()`, but it is private and not an authorized public seam | A narrow intent-level Kernel audit method for CLI mutation events, preserving current best-effort failure behavior | Making the private helper public or throwing on audit failure would widen API or change command outcomes | Allowed/reviewed/blocked CLI events retain event type, target, actor, details, workspace, and failure isolation |
| CLI-owned graph lifecycle as a whole | `kernel.graph` compatibility surface | Mixed | CLI coordinates backup, restore, maintenance, status, audit, startup, and shutdown around one Kernel instance | Individual safe replacements above | No general-purpose graph adapter or broad pass-through facade | A broad adapter could merely rename direct coupling while preserving mutable graph authority | Contract test must reject new CLI references to `_nodes`/`_edges` and reject a generic mutable graph escape hatch |

## Source Findings

### Independent `dbPath` is not current CLI behavior

Kernel construction accepts an independent `dbPath`, but `_backupOptions()`
does not read or retain that value. It reads `graph.memoryPath` and passes
`normalizeDbPath(memoryPath)` to backup and restore path resolution. This gate
must preserve that behavior rather than silently add independent `dbPath`
support.

Record the separate behavior-change question as:

```text
PERSISTENCE-PATH-ALIGNMENT:
Determine whether backup/restore should honor an independently configured
Kernel dbPath. This is a behavior-change decision, not part of REFACTOR-1C.
```

### Status counts already have a safe read path

`Graph.getStats()` returns:

```text
nodes = nodeCount()
edges = edgeCount()
```

With no workspace argument, those methods use the same global collection
counts currently calculated by `cli.js`. The status migration therefore must
not introduce a new node or edge collection accessor.

### `selfEvolve()` is not an optimize replacement

`Kernel.selfEvolve()` invokes graph optimization, but it also performs dream
processing, graph admission, contradiction consolidation, optional save, and
additional reporting. Routing the CLI `optimize` command through
`selfEvolve()` would change behavior and is forbidden.

### The existing audit helper is private

`Kernel._appendAuditEvent()` centralizes best-effort graph audit writes, but its
underscore naming and current internal usage do not make it a supported public
CLI seam. A future gate must define an intent-level operation rather than
expose the private helper unchanged.

### Server debt is separate

`server.js` also reads graph statistics, graph edges, and graph lifecycle
methods. Those accesses are not executed through the CLI command paths listed
above and are not authorized for migration in this gate. Future CLI seams must
not silently change server behavior or claim to close server graph coupling.
If a proposed CLI implementation requires a shared server migration, stop and
open a separate reconciliation scope.

Test-only direct graph access used to set up or inspect fixtures is not runtime
consumer authority and is not part of the CLI migration. Existing tests may be
updated only in the separately authorized implementation or regression-test
gate that owns the affected behavior.

## Seam Selection Rules

For each coupling, use the first sufficient option:

1. an existing public method with equivalent behavior;
2. a narrow read-only accessor returning immutable data;
3. a narrow intent-level Kernel facade method;
4. only if unavoidable, an isolated adapter with no mutable graph escape hatch.

The following designs are forbidden:

- exposing `_nodes`, `_edges`, or aliases of their live values;
- returning the Graph instance through a new accessor;
- adding a generic `executeGraphOperation()` pass-through;
- blessing all existing Graph methods as stable Kernel API;
- routing narrow commands through broader operations with extra side effects;
- changing graph ownership, persistence format, workspace semantics, or
  constructor selection to remove CLI coupling.

## Proposed Implementation Decomposition

No implementation gate is authorized by this document. Subject to separate
exact-base approvals, the work should be split as follows:

### REFACTOR-1C1 CLI graph read contract tests

- Lock current status output and global count semantics.
- Lock persistence-path resolution used by backup and restore.
- Add a source-boundary assertion that CLI runtime code does not read
  `_nodes` or `_edges` after migration.
- Do not modify runtime code in the test-scope gate.

### REFACTOR-1C2 Kernel lifecycle and maintenance seam scope

- Define the minimum persistence descriptor, reload, persist, and optimize
  intent methods.
- Freeze synchronous behavior, return shapes, error behavior, and side
  effects before implementation.
- Decide whether startup's explicit load is redundant without changing it in
  the scope gate.

### REFACTOR-1C3 Kernel CLI audit seam scope

- Define an intent-level CLI mutation audit input.
- Preserve current audit event fields and best-effort failure isolation.
- Keep generic Graph audit mutation private.

### REFACTOR-1C4 Mechanical CLI migration

- Implement only seams approved by the preceding scope and test gates.
- Replace the inventoried CLI calls without changing command text, ordering,
  gate decisions, persistence behavior, constructor selection, or output.
- Run targeted CLI, facade, constructor-variant, mutation-gate, persistence,
  and full-suite validation.

These gates may be subdivided further if review finds that lifecycle,
maintenance, audit, or status behavior cannot be changed safely in one PR.

## Regression Ownership

Future tests must cover at least:

- `durum` exact node/edge counts and existing output sections;
- custom `memoryPath`-derived and default backup/restore persistence paths;
- restored state becoming visible after reload;
- startup load behavior without duplicate observable effects;
- `kaydet` and exit persistence ordering and messages;
- `optimize` return counts and absence of self-evolution side effects;
- CLI mutation-gate decisions remaining unchanged;
- audit event shape and non-propagating audit failures;
- Kernel v1 default and explicit KernelV2 selection remaining unchanged;
- absence of new mutable graph collection exposure;
- existing facade and constructor-variant contract tests remaining green.

## Allowed Scope for This Gate

Only:

```text
docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md
```

## Forbidden Scope for This Gate

- `cli.js`
- `kernel.js`
- `graph.js`
- `kernel.d.ts`
- tests or fixtures
- MCP or HTTP server code
- KernelV2 or constructor selection
- memory-store, schema, package, dependency, workflow, or Docker changes
- V5 work
- Policy Auditor work
- broad graph redesign
- implementation, commit mixing, or automatic merge of a successor gate

## Acceptance Criteria

- Every direct CLI graph coupling is inventoried and classified.
- Read, mutation, persistence, audit, and observable effects are explicit.
- Existing safe replacements are distinguished from required new seams.
- `_nodes` and `_edges` are not proposed as public API.
- The minimum-seam preference order is binding.
- Server and test-only coupling are recorded without entering this gate.
- Regression ownership and migration risks are explicit.
- Future implementation is decomposed into separately authorized gates.
- Exactly this task-pack changes.
- `git diff --check` passes.
- Tests are not run because this gate is docs/task-pack only.

## Stop Conditions

Stop with `REFACTOR-1C_BLOCKED_SOURCE_CONFLICT` if:

- CLI behavior cannot be preserved without broad graph redesign;
- a proposed seam would expose mutable graph collections or the Graph object;
- the same implementation path also requires MCP or server migration;
- source behavior or observable output is unclear or contradictory;
- runtime implementation is required to complete this scope document;
- a new verdict, receipt, persistence, workspace, or constructor contract is
  required;
- the authorized base, branch, or worktree reality is not exact.

## Non-Claims

- No CLI graph coupling has been removed.
- No Kernel facade method has been added.
- No graph internal has been made public or private.
- No persistence, audit, optimize, status, startup, or shutdown behavior has
  changed.
- No server or MCP coupling has been closed.
- No runtime, test, type, package, V5, or Policy Auditor work has been done.
- No broad Kernel or Graph refactor has begun.

## Validation

```powershell
git diff --name-only `
  72786e7cf1e8dd5debf190c48c8a259020e47d5c..HEAD

git diff --check `
  72786e7cf1e8dd5debf190c48c8a259020e47d5c..HEAD

git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md
```

Tests are not run because this gate adds a docs/task-pack file only.

## Success Verdict

```text
REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE_READY_FOR_REVIEW
```

Do not merge and do not start an implementation gate automatically.
