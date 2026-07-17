# REFACTOR-1C1 CLI Graph Read Contract Test Scope

## Purpose

Define the exact test scope for the read-only CLI graph behavior identified by
`REFACTOR-1C`. This task-pack selects the existing test owner and separates
tests that can lock current behavior now from a source-boundary assertion that
can become executable only after the separately authorized CLI migration.

This gate adds no test and changes no runtime behavior.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base:
  `b00dde2aa2f71c3bb6c257b7c710ec62eb9a56ad`
- Previous checkpoint: `REFACTOR-1C_CLOSEOUT_AUDIT_GREEN`
- Current gate: `REFACTOR-1C1_CLI_GRAPH_READ_CONTRACT_TEST_SCOPE`
- Future test implementation gate:
  `REFACTOR-1C1A_CLI_GRAPH_READ_CONTRACT_TESTS`

The scope-definition base records the source used to prepare this task-pack.
It is not the future test implementation base. `REFACTOR-1C1A` may begin only
from a separately authorized exact post-merge canonical `main` SHA after this
task-pack is reviewed, merged, and closed.

Before future implementation, branch must be `main`, `HEAD` must equal
`origin/main`, `HEAD` must equal the separately authorized implementation
base, and this task-pack must exist unchanged. Otherwise stop with
`BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`.

## Governing Sources

- `docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md`
- `docs/refactor/kernel-facade-contract.md`
- `cli.js`
- `cli.test.js`
- `graph.js`
- `persistencePaths.js`
- `backupRestore.js`
- `test/kernel-facade-contract.test.js`
- `test/kernel-constructor-variant-contract.test.js`

## Locked Current Behavior

### `durum` count contract

The CLI currently reports global graph counts:

```text
Durum: <nodes> düğüm, <edges> kenar, entropi: <value>
```

The current implementation reads `_nodes` and `_edges` directly. The safe
replacement identified by `REFACTOR-1C` is `Graph.getStats()`, whose `nodes`
and `edges` values call `nodeCount()` and `edgeCount()` without a workspace
argument. Those methods count the same global collections.

Tests must lock the observable count and output behavior, not direct access to
the collections.

### Backup and restore path contract

`CLI._backupOptions()` currently:

1. reads `kernel.graph.memoryPath`, falling back to `memory.json`;
2. derives the database path with `normalizeDbPath(memoryPath)`;
3. passes both paths to `resolvePersistencePaths()`;
4. permits the command-specific `extra` options to override resolved values.

An independent `KernelOptions.dbPath` is not read by `_backupOptions()` and is
not retained on the observable Graph compatibility surface. The future test
must preserve the current `memoryPath`-based database-path derivation. It must
not create or imply independent `dbPath` support.

The separate behavior-change question remains deferred to:

```text
PERSISTENCE-PATH-ALIGNMENT
```

## Existing Test Coverage

| Existing test | Current evidence | Missing evidence | Decision |
| --- | --- | --- | --- |
| `cli.test.js` — `execute: durum komutu istatistik gösterir` | output contains the words `düğüm` and `kenar` | exact global node/edge counts and stable status prefix | strengthen in place |
| `cli.test.js` — `execute: backup ve restore komutlari memory dosyasini geri yukler` | custom persistence files can be backed up and restored | explicit `memoryPath`-derived DB selection, default resolution, and independent `dbPath` non-support | strengthen in place |
| `test/kernel-facade-contract.test.js` | graph and memory compatibility surfaces remain observable | CLI command behavior | rerun only; do not extend |
| `test/kernel-constructor-variant-contract.test.js` | CLI/MCP constructor selection matrix | CLI graph read behavior | rerun only; do not extend |

## Chosen Test-File Strategy

The future `REFACTOR-1C1A` test implementation may change exactly:

```text
cli.test.js
```

Do not add a new contract-test file. `cli.test.js` already owns both command
behaviors, test helpers, temporary filesystem setup, and CLI construction.
Creating a second file would duplicate setup and split ownership of the same
observable commands.

The future implementation must strengthen the existing tests or add adjacent
cases in the same relevant describe block. It must not copy unrelated CLI
parsing, constructor, facade, mutation-gate, or transport coverage.

## Future Executable Test Contract

### Exact global status counts

The strengthened status test must:

- create an isolated CLI with persistence loading disabled;
- seed deterministic graph data through an existing admitted test path;
- calculate expected global counts through `graph.getStats()` before invoking
  `durum`;
- assert the returned first line contains the exact expected node and edge
  values in the existing order and wording;
- retain the current entropy field and avoid asserting a fabricated constant
  entropy value;
- avoid reading `_nodes` or `_edges` in the test itself;
- close the CLI agent storage plus Kernel graph/memory resources and remove
  temporary files using the explicit lifecycle order below.

The test must not introduce workspace filtering. The command currently reports
global totals.

### Custom `memoryPath` derivation

The strengthened persistence test must prove:

```text
custom memoryPath:
<root>/<name>.json

selected database path:
<root>/<name>.db
```

The assertion may inspect the existing `_backupOptions()` output because that
method is the current owner of CLI path selection. It must also retain the
existing observable backup/restore round-trip assertion so path calculation
is not tested without command behavior.

### Default resolution

The test must isolate `process.cwd()` and all relevant persistence environment
variables before asserting defaults. It must save whether each modified value
originally existed and restore the exact prior process state in `finally`.

The default contract is:

```text
memoryPath:    <isolated cwd>/memory.json
dbPath:        <isolated cwd>/memory.db
backupBaseDir: derived from the resolved memory location
```

The test must not read or write the repository's real persistence files.

### Independent `dbPath` remains unsupported by CLI backup selection

Constructing a Kernel with both a custom `memoryPath` and a different custom
`dbPath` must not cause `_backupOptions()` to select that independent DB path.
The expected CLI backup DB path remains the path derived from `memoryPath`.

This is a current-behavior lock, not a claim that the behavior is desirable.
Changing it requires the separately scoped `PERSISTENCE-PATH-ALIGNMENT`
decision.

## `_nodes` and `_edges` Source Boundary

The current `cli.js` still reads:

```text
kernel.graph._nodes
kernel.graph._edges
```

Therefore `REFACTOR-1C1A` must not add a currently failing assertion that these
tokens are absent. Doing so would make the test-only gate self-contradictory or
force an unauthorized runtime patch.

The future mechanical CLI migration gate must add an adjacent `cli.test.js`
source-boundary assertion after replacing those accesses. That assertion must
read `cli.js` as repository text and reject direct runtime references to:

```text
.graph._nodes
.graph._edges
```

It must not ban those strings repository-wide because historical tests and
other separately scoped consumers still use graph internals. It must not claim
to close server, MCP, or test-fixture coupling.

## Test Isolation

Future tests must:

- use unique temporary directories;
- construct new persistence cases through `new CLI({ kernel: ... })` or an
  explicitly supplied managed Kernel instance rather than create a default
  Kernel and replace it afterward;
- pass both `useSQLite: false` and `memoryStoreUseSQLite: false` to disable
  Kernel Graph and MemoryStore SQLite for these cases;
- recognize that `new CLI(...)` still creates an agent `AxiomStorage` SQLite
  connection at the database path derived from the Kernel graph memory path;
- close `cli.agent.storage` immediately after CLI construction and before
  inspecting, writing, backing up, restoring, or deleting the derived DB file;
- disable plugin loading and production persistence;
- save and exactly restore `process.cwd()` and relevant environment variables;
- use `try/finally` for resource and filesystem cleanup;
- avoid concurrent tests that mutate process-wide cwd or environment state;
- clean up in this order: close agent storage, close graph/memory through the
  existing Kernel lifecycle path, restore cwd and environment, then remove the
  temporary directory;
- not alter require cache, monkey-patch production modules, or start CLI
  interactive mode, MCP transport, HTTP server, or network listeners.

Closing the agent storage is test isolation, not a runtime lifecycle change.
The read-contract cases do not exercise agent persistence. If agent storage
cannot be observed and closed through the current CLI instance, stop instead
of adding a runtime injection seam in this test-only gate.

Managed-instance partial-construction cleanup remains a separate
`TEST-HARDENING` backlog item. This gate must not broaden into a general
`cli.test.js` cleanup.

## Future Validation

The future `REFACTOR-1C1A` implementation must run:

```powershell
node --test cli.test.js

node --test `
  cli.test.js `
  test/kernel-facade-contract.test.js `
  test/kernel-constructor-variant-contract.test.js

npm test

git diff --check
git diff --name-only origin/main...HEAD
git status --short
```

Expected implementation scope:

```text
cli.test.js
```

## Acceptance Criteria

- Existing CLI status and backup/restore tests remain owned by `cli.test.js`.
- Status behavior is locked to exact global node and edge counts.
- Existing status wording and entropy field remain present.
- Custom `memoryPath` deterministically selects its derived DB path.
- Default paths are tested only in an isolated temporary cwd.
- Independent `dbPath` remains outside CLI backup selection.
- No new contract-test file duplicates CLI behavior.
- No executable absence assertion contradicts current `_nodes`/`_edges`
  runtime access.
- The future migration-owned source-boundary assertion is explicitly defined.
- Targeted and full suites complete with `0 fail` in the future test gate.
- No runtime, type, package, fixture, schema, workflow, MCP, server, V5, or
  Policy Auditor file changes.

## Stop Conditions

Stop with `REFACTOR-1C1_BLOCKED_SOURCE_CONFLICT` if:

- exact status counts cannot be tested without runtime modification;
- backup/restore path selection differs from the documented source behavior;
- independent `dbPath` support is required for a test to pass;
- a source-boundary test requires changing `cli.js` in the test-only gate;
- a new test file is required despite existing `cli.test.js` ownership;
- process cwd, environment, persistence, or resources cannot be isolated and
  restored safely;
- runtime, type, package, fixture, schema, workflow, MCP, server, Graph, V5,
  or Policy Auditor changes become necessary;
- targeted or full-suite validation fails.

Use `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH` for a base, branch, or worktree
mismatch and `BLOCKED_BY_SCOPE_DRIFT` for any unauthorized changed file.

## Allowed Scope for This Gate

Only:

```text
docs/task-packs/refactor-1c1-cli-graph-read-contract-test-scope.md
```

## Forbidden Scope for This Gate

- `cli.js`
- `cli.test.js`
- `kernel.js`
- `graph.js`
- `kernel.d.ts`
- all other tests and fixtures
- audit, reload, persist, optimize, or server/MCP seam design
- `PERSISTENCE-PATH-ALIGNMENT` implementation
- package, dependency, workflow, Docker, V5, or Policy Auditor changes
- runtime implementation or successor-gate work

## Non-Claims

- No test has been added or strengthened.
- No CLI graph access has been removed.
- No `_nodes` or `_edges` absence assertion currently passes.
- No independent `dbPath` support has been added or approved.
- No runtime, type, package, persistence, server, MCP, V5, or Policy Auditor
  behavior has changed.
- No successor gate has begun.

## This Gate Validation

```powershell
git diff --name-only `
  b00dde2aa2f71c3bb6c257b7c710ec62eb9a56ad..HEAD

git diff --check `
  b00dde2aa2f71c3bb6c257b7c710ec62eb9a56ad..HEAD

git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1c1-cli-graph-read-contract-test-scope.md
```

Tests are not run because this gate adds one docs/task-pack file only.

## Success Verdict

```text
REFACTOR-1C1_CLI_GRAPH_READ_CONTRACT_TEST_SCOPE_READY_FOR_REVIEW
```

Do not merge and do not start `REFACTOR-1C1A` automatically.
