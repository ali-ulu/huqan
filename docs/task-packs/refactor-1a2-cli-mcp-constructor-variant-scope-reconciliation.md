# REFACTOR-1A2 CLI/MCP Constructor Variant Scope Reconciliation

## Purpose

Reconcile the public Kernel seam test scope with the existing constructor
selection behavior in the CLI and MCP server.

The repository has two intentional runtime paths:

- Kernel v1 is the canonical default public seam.
- `KernelV2` is an explicitly selected alternate runtime path.

This task-pack documents that distinction. It does not change constructor
selection, runtime behavior, tests, package entry points, or graph ownership.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base: `b77d49f8158a2085f12f3d8314510604360e1879`
- Previous checkpoint: `REFACTOR-1A_BLOCKED_SOURCE_CONFLICT`
- Authorized successor: `REFACTOR-1A_PUBLIC_KERNEL_SEAM_TEST_SCOPE`

The scope-definition base records the source state used for this
reconciliation. A future test implementation must use a separately authorized
exact canonical `main` SHA after all required scope documents are merged.

## Source Findings

The current source establishes:

- `package.json` maps the package library entry to `kernel.js`.
- `kernel.js:2415` exports the Kernel v1 constructor.
- `kernel.v2.js:838` exports the distinct `KernelV2` constructor.
- `cli.js:4-5` imports both constructors.
- `cli.js:18-21` selects `KernelV2` only when `opts.version` or
  `AXIOM_KERNEL_VERSION` equals `v2`; every other value selects Kernel v1.
- `cli.js:740` exports `createKernel`, so constructor selection can be tested
  without starting the interactive CLI.
- `mcpServer.js:4-5` imports both constructors.
- `mcpServer.js:493-498` selects `KernelV2` only when
  `AXIOM_KERNEL_VERSION === 'v2'`; otherwise it selects Kernel v1.
- `mcpServer.js:1127` exports `createKernelFromEnv`, so constructor selection
  can be tested without starting an MCP transport.
- `server.js:5` consumes the CLI, and therefore inherits the same explicit
  variant selection behavior instead of defining a third constructor factory.
- Existing CLI and MCP tests already exercise V2 opt-in behavior.

No source evidence describes `KernelV2` as deprecated. Repository docs and
runtime status text describe it as optional or opt-in. This task-pack therefore
classifies it as an **explicitly selected alternate runtime path**, not as a
deprecated path.

## Constructor Inventory

| Consumer | Default constructor | Alternate constructor | Selection mechanism | Path class | Compatibility sensitivity |
| --- | --- | --- | --- | --- | --- |
| Package entry | Kernel v1 | none | `package.json` main entry | public | identity must remain equal to `require('./kernel')` |
| CLI | Kernel v1 | `KernelV2` | `opts.version === 'v2'` or `AXIOM_KERNEL_VERSION=v2` | consumer factory | default and explicit opt-in must remain deterministic |
| MCP server | Kernel v1 | `KernelV2` | `AXIOM_KERNEL_VERSION=v2` | consumer factory | default and explicit opt-in must remain deterministic |
| HTTP server | inherited CLI selection | inherited `KernelV2` selection | CLI construction plus `AXIOM_KERNEL_VERSION` | indirect consumer | must not define a third constructor identity |
| Tests | explicit per test | explicit per test | direct imports or exported factories | internal evidence | must not redefine production selection rules |
| Examples/scripts | source-specific explicit import | source-specific explicit import | direct source code choice | non-package consumer | not part of the package-entry identity contract |

## Canonical V1 Behavior

The canonical public Kernel identity is:

```text
require('..') === require('./kernel')
```

When no explicit variant is selected:

- the package entry resolves Kernel v1;
- the CLI factory creates Kernel v1;
- the MCP factory creates Kernel v1;
- the HTTP server inherits the CLI default.

This is a default-selection contract. It does not prohibit an explicit
alternate constructor path.

## KernelV2 Classification

`KernelV2` is an explicitly selected alternate runtime path.

```text
Kernel v1:
canonical default public seam

KernelV2:
explicitly selected alternate runtime path
```

The two constructors are not expected to have object identity equality.
Selection of `KernelV2` must be deliberate and observable through the existing
selector inputs. This gate does not claim that the alternate path is legacy,
deprecated, experimental, equivalent to Kernel v1, or part of the package
public entry.

## Constructor Identity Contract

The rejected assertion is:

```text
CLI and MCP never expose a second constructor identity.
```

The reconciled contract is:

```text
Default v1 path:
CLI and MCP resolve the canonical Kernel v1 constructor.

Explicit V2 path:
CLI and MCP resolve KernelV2 when the existing exact selector requests v2.
KernelV2 is not required to have Kernel v1 constructor identity.
```

Package-entry identity remains a v1-only contract. Explicit V2 selection must
not alter what `require('..')` exports.

## Future Test Scope

The reopened `REFACTOR-1A_PUBLIC_KERNEL_SEAM_TEST_SCOPE` may define tests for:

### Package And Default V1 Path

- `require('..')` remains identical to `require('../kernel')` from tests;
- the package entry exports Kernel v1;
- `cli.createKernel()` returns a Kernel v1 instance when neither selector is
  set;
- `mcpServer.createKernelFromEnv()` returns a Kernel v1 instance when
  `AXIOM_KERNEL_VERSION` is absent or not `v2`;
- default selection does not mutate the caller's environment or options.

### Explicit V2 Path

- `cli.createKernel({ version: 'v2' })` returns a `KernelV2` instance;
- `AXIOM_KERNEL_VERSION=v2` selects `KernelV2` in the CLI factory;
- `AXIOM_KERNEL_VERSION=v2` selects `KernelV2` in the MCP factory;
- explicit V2 selection does not silently fall back to Kernel v1;
- explicit V2 selection does not change package-entry identity.

These tests must observe existing behavior only. They must not require
constructor migration, runtime wiring changes, or facade equivalence between
Kernel v1 and `KernelV2`.

## Test Method

The preferred test seams already exist:

1. Use exported `cli.createKernel` for CLI selection.
2. Use exported `mcpServer.createKernelFromEnv` for MCP selection.
3. Save and restore `AXIOM_KERNEL_VERSION` around each environment-based case.
4. Construct with isolated temporary persistence paths, plugins disabled, and
   SQLite disabled where the existing factory inputs permit it.
5. Close graph and memory resources through the existing lifecycle path.

Starting the interactive CLI, MCP transport, HTTP server, network listeners,
or production persistence is not required to test constructor selection.

If future tests cannot use these exported factories without changing runtime
code, stop with:

```text
REFACTOR-1A2_BLOCKED_VARIANT_SELECTION_NOT_TESTABLE
```

## CLI Graph Internal Coupling

The CLI currently accesses graph internals and graph lifecycle methods,
including:

- `kernel.graph._nodes`
- `kernel.graph._edges`
- `kernel.graph.optimize()`
- `kernel.graph.save()`

This coupling is current runtime reality, but it is not part of the public
Kernel seam. New public-seam contract tests must not bless these internals as
stable public APIs.

This gate does not remove the coupling, design a replacement facade, migrate
the CLI, or change graph behavior. That work is deferred to:

```text
REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE
```

`REFACTOR-1C` must not begin until the public seam test chain is closed and a
separate authorization is supplied.

## Return To REFACTOR-1A

`REFACTOR-1A_PUBLIC_KERNEL_SEAM_TEST_SCOPE` may reopen with this partition:

```text
Package/facade tests:
canonical Kernel v1 identity

CLI/MCP tests:
default v1 selection
explicit KernelV2 selection

Excluded:
CLI graph internal behavior
KernelV2 facade equivalence
KernelV2 removal, migration, or deprecation
```

The reopened gate must choose the smallest test-file strategy consistent with
the existing facade and CLI/MCP tests. It must not duplicate coverage merely
to create a new file.

## Acceptance Criteria

- Kernel v1 default role is documented.
- `KernelV2` alternate role is documented without unsupported lifecycle claims.
- CLI and MCP selector behavior is documented from current source.
- The incorrect single-constructor assertion is rejected.
- Future tests separate default-v1 and explicit-v2 cases.
- Package-entry identity remains a v1-only contract.
- CLI graph internals are not declared public.
- No runtime, test, package, type, CLI, MCP, graph, or V5 file changes.

## Stop Conditions

Stop with `REFACTOR-1A2_BLOCKED_DEEPER_VARIANT_CONFLICT` if future source
review finds:

- the CLI default constructor cannot be determined;
- the MCP default constructor cannot be determined;
- variant selection is nondeterministic;
- `KernelV2` is selected implicitly without an observable rule;
- the package entry may resolve to `KernelV2`;
- constructor selection cannot be tested without runtime refactoring;
- CLI and MCP use materially different undocumented selection rules.

Use `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH` if the authorized base, branch, or
worktree reality does not match the gate authorization.

## Non-Claims

- No constructor path changed.
- No `KernelV2` path removed or deprecated.
- No package entry changed.
- No CLI, MCP, server, graph, or memory behavior changed.
- No graph internals migrated or made public.
- No tests added.
- No runtime or type code changed.
- No Policy Auditor work performed.

## Validation

This docs-only gate requires:

```bash
git diff --check
git diff --name-only origin/main...HEAD
git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1a2-cli-mcp-constructor-variant-scope-reconciliation.md
```

Tests are not run because this gate adds a task-pack only.

## Next Gates

If independent review, merge, and closeout are green, return to:

```text
REFACTOR-1A_PUBLIC_KERNEL_SEAM_TEST_SCOPE
```

Deferred and not authorized:

```text
REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE
```

Do not start either gate automatically.
