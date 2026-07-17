# REFACTOR-1A Public Kernel Seam Test Scope

## Purpose

Define the exact contract-test scope for the public Kernel facade and the
reconciled CLI/MCP constructor variants.

This task-pack authorizes no test or runtime implementation. It converts the
closed `REFACTOR-1A0`, `REFACTOR-1A1`, and `REFACTOR-1A2` source decisions into
a bounded future test plan.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base: `6cc50f3d68aa4567cda3c95fe3d0c0fc0b9f5acf`
- Previous checkpoint: `REFACTOR-1A2_CLOSEOUT_AUDIT_GREEN`
- Authorized successor: `REFACTOR-1B_PUBLIC_KERNEL_SEAM_CONTRACT_TESTS`

The scope-definition base records the source state used to prepare this
task-pack. It is not the future implementation base. `REFACTOR-1B` may begin
only from a separately authorized exact post-merge canonical `main` SHA after
this task-pack is reviewed, merged, and closed out.

Before future implementation, branch must be `main`, `HEAD` must equal
`origin/main`, `HEAD` must equal the separately authorized implementation
base, and this task-pack must exist unchanged. Otherwise stop with
`BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`.

## Governing Contracts

This scope is governed by:

- `docs/refactor/kernel-facade-contract.md`
- `docs/task-packs/refactor-1-public-kernel-seam-scope-definition.md`
- `docs/task-packs/refactor-1a0-kernel-type-surface-alignment-scope.md`
- `docs/task-packs/refactor-1a2-cli-mcp-constructor-variant-scope-reconciliation.md`

The future tests must observe those contracts. They must not revise runtime
behavior or invent a new constructor policy.

## Locked Source Contract

```text
Kernel v1:
canonical default public seam

KernelV2:
explicitly selected alternate runtime path

CLI default:
Kernel v1

CLI explicit v2:
opts.version === 'v2'
or AXIOM_KERNEL_VERSION === 'v2'

MCP default:
Kernel v1

MCP explicit v2:
AXIOM_KERNEL_VERSION === 'v2'

CLI graph internals:
excluded from the public seam contract
```

The package entry remains a Kernel v1 identity contract. The alternate
`KernelV2` constructor is not required to equal Kernel v1.

## Existing Test Coverage

| Existing test file | Existing coverage | Missing coverage | Decision | Reason |
| --- | --- | --- | --- | --- |
| `test/kernel-facade-contract.test.js` | package entry identity; static markers; instance contract version; frozen facade methods; runtime graph and memory surfaces | declaration-level graph and `memory.close()` alignment | extend narrowly | type/runtime alignment belongs with the existing facade contract |
| `cli.test.js` | explicit `opts.version: 'v2'` creates `KernelV2` and preserves one CLI flow | default v1, env selection, non-v2 behavior, precedence, package identity | do not extend | broad CLI behavior suite is not the narrow constructor contract owner |
| `mcpServer.test.js` | uses exported MCP factory and exercises a V2 transport flow | direct default/non-v2/exact-v2 constructor identity | do not extend | transport integration is broader than factory selection |
| `test/faz2-mcp-approval-persistence.contract.test.js` | factory export and shared-state behavior with a v1-oriented test environment | constructor variant matrix | do not extend | approval persistence is a separate contract |

Existing tests remain required regression evidence. Their partial V2 coverage
does not replace the missing focused selection matrix.

## Chosen Test-File Strategy

The future `REFACTOR-1B` gate may change exactly:

```text
test/kernel-facade-contract.test.js
test/kernel-constructor-variant-contract.test.js
```

### Existing Facade Test

Extend `test/kernel-facade-contract.test.js` only to lock declaration/runtime
alignment:

- `kernel.d.ts` declares the graph compatibility surface;
- `kernel.d.ts` declares `memory.close(): void`;
- the already existing runtime test continues to prove matching observable
  graph and memory surfaces.

The declaration check may read `kernel.d.ts` as repository text and assert only
the minimum contract fragments. It must not add TypeScript, a compiler, a
typecheck script, generated declarations, or another dependency.

The existing tests must remain the owners of:

- `package entry resolves to the canonical Kernel constructor`;
- `Kernel exposes the documented static contract markers`;
- `Kernel instances expose the frozen high-level facade methods`;
- `graph and memory remain observable compatibility surfaces`.

Those tests must not be copied into the new constructor-variant file.

### New Constructor Variant Test

Add `test/kernel-constructor-variant-contract.test.js` for the focused CLI/MCP
factory selection matrix. This separation avoids mixing constructor selection
with interactive CLI commands, MCP transport behavior, approval persistence,
or the package facade method inventory.

## Package And Facade Contract

The future implementation must preserve:

- `require('..') === require('../kernel')` from the test directory;
- package export type is `function`;
- constructor name is `Kernel`;
- `Kernel.CONTRACT_VERSION` exists;
- `Kernel.AXIOM_ERROR` exists;
- instance `contractVersion` equals `Kernel.CONTRACT_VERSION`;
- all frozen high-level facade methods remain callable;
- `kernel.graph` remains observable with callable `load` and `save`;
- `kernel.memory` remains observable with callable `close`.

These assertions already exist and must be rerun, not duplicated.

## Type And Runtime Alignment

The future facade test extension must prove the minimum aligned shape:

```text
kernel.d.ts declares graph
kernel.d.ts declares graph.load()
kernel.d.ts declares graph.save()
kernel.d.ts declares memory
kernel.d.ts declares memory.close(): void
runtime exposes matching graph and memory surfaces
```

This is a compatibility check, not a full TypeScript conformance system. It
must not expose additional `MemoryStore` internals or bless direct graph/memory
mutation as a stable extension API.

## CLI Constructor Selection

The CLI factory is exported as `CLI.createKernel` from `cli.js`. Future tests
must use that factory directly and must not start the interactive CLI.

### Default V1 Cases

- `createKernel()` returns a Kernel v1 instance when
  `AXIOM_KERNEL_VERSION` is absent;
- `createKernel({})` returns Kernel v1 under the same condition;
- a non-v2 environment value selects Kernel v1;
- a non-v2 `opts.version` value selects Kernel v1;
- default selection leaves package-entry identity unchanged.

### Explicit V2 Cases

- `createKernel({ version: 'v2' })` returns a `KernelV2` instance;
- `AXIOM_KERNEL_VERSION=v2` returns a `KernelV2` instance when no option-level
  version is supplied;
- explicit V2 selection does not silently fall back to Kernel v1;
- explicit V2 selection does not change what `require('..')` exports.

### Selector Precedence

Current source uses:

```js
const selected = version || process.env.AXIOM_KERNEL_VERSION;
```

The observed precedence is therefore:

```text
truthy opts.version
-> AXIOM_KERNEL_VERSION
-> default Kernel v1
```

The future test must lock these current cases:

- `opts.version='v2'` selects V2 regardless of an absent or non-v2 env value;
- a truthy non-v2 `opts.version` overrides env `v2` and selects Kernel v1;
- a missing or falsey option permits env `v2` to select `KernelV2`;
- any final selected value other than exact `v2` selects Kernel v1.

This precedence may appear surprising, but changing it is a behavior change
outside `REFACTOR-1B`. Any proposed precedence correction requires a separate
scope and must not be hidden in a contract-test PR.

## MCP Constructor Selection

The MCP factory is exported as `createKernelFromEnv` from `mcpServer.js`.
Future tests must call that factory directly and must not start MCP transport.

### Default V1 Cases

- absence of `AXIOM_KERNEL_VERSION` returns a Kernel v1 instance;
- empty or non-v2 values return Kernel v1;
- default selection leaves package-entry identity unchanged.

### Explicit V2 Cases

- exact `AXIOM_KERNEL_VERSION=v2` returns a `KernelV2` instance;
- explicit V2 selection does not silently return Kernel v1;
- explicit V2 selection does not change what `require('..')` exports.

The MCP selector has no option-level override in the current factory. Tests
must not introduce one.

## Constructor Identity Boundaries

Correct expectations:

```text
Package entry === Kernel v1 constructor
CLI default instance instanceof Kernel v1
MCP default instance instanceof Kernel v1
CLI explicit v2 instance instanceof KernelV2
MCP explicit v2 instance instanceof KernelV2
KernelV2 constructor identity !== Kernel v1 constructor identity
```

Forbidden expectation:

```text
KernelV2 must equal Kernel v1 constructor.
```

## Test Isolation

Future constructor tests must:

- use temporary persistence paths;
- disable plugin loading;
- disable SQLite where supported by factory input or environment;
- avoid network listeners, interactive CLI startup, MCP transport, and HTTP
  server startup;
- save whether each mutated environment variable originally existed;
- restore the exact prior environment state in `finally` blocks;
- avoid concurrent mutation of `AXIOM_KERNEL_VERSION` within the test file;
- close graph/memory resources through the existing lifecycle path;
- remove temporary artifacts where created;
- avoid persistent module monkey-patching or require-cache replacement.

The new test may use the already exported factories. If runtime changes become
necessary for testability, stop instead of widening scope.

## Negative Contract Cases

The future tests must fail if:

- package entry no longer equals Kernel v1;
- CLI default unexpectedly selects `KernelV2`;
- MCP default unexpectedly selects `KernelV2`;
- an explicit exact V2 selector silently falls back to v1;
- CLI selector precedence changes;
- `AXIOM_KERNEL_VERSION` leaks between tests;
- `kernel.d.ts` loses the graph compatibility declaration;
- `kernel.d.ts` loses `memory.close(): void`;
- runtime graph or memory compatibility surfaces disappear.

Production modules must not be permanently monkey-patched to manufacture a
negative case.

## Explicit Exclusions

This contract-test gate must not test or claim:

- full facade equivalence between `KernelV2` and Kernel v1;
- identical graph or memory surfaces for `KernelV2`;
- production equivalence, deprecation, migration, or replacement of either
  constructor;
- CLI command behavior;
- MCP tool or transport behavior;
- HTTP server behavior;
- direct graph mutation as a public API;
- graph or memory ownership changes.

The following CLI coupling remains current runtime reality but is excluded
from public Kernel seam contract tests:

```text
kernel.graph._nodes
kernel.graph._edges
kernel.graph.optimize()
kernel.graph.save()
```

It remains deferred to the separately authorized future gate:

```text
REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE
```

## Future Validation

The future `REFACTOR-1B` implementation must run:

```bash
node --test test/kernel-facade-contract.test.js
node --test test/kernel-constructor-variant-contract.test.js
node --test test/kernel-facade-contract.test.js test/kernel-constructor-variant-contract.test.js
npm test
git diff --check
git diff --name-only origin/main...HEAD
git status --short
```

Expected implementation scope:

```text
test/kernel-facade-contract.test.js
test/kernel-constructor-variant-contract.test.js
```

No runtime, type, package, fixture, schema, workflow, CLI, MCP, server, graph,
memory-store, V5, or Policy Auditor file may change.

## Acceptance Criteria

- Existing facade contract tests remain green.
- Declaration/runtime graph and memory alignment is locked.
- Package entry remains Kernel v1.
- CLI default v1 and explicit V2 selection are verified.
- CLI selector precedence is documented and verified.
- MCP default v1 and explicit V2 selection are verified.
- Environment state is restored after every relevant test.
- `KernelV2` equivalence is not claimed.
- CLI graph internals are not made public.
- Targeted tests and full suite complete with `0 fail`.
- `git diff --check` passes.
- Changed files match the authorized test-only scope exactly.

## Stop Conditions

Stop with `REFACTOR-1A_BLOCKED_SOURCE_CONFLICT` if:

- existing CLI/MCP tests contradict the documented selection behavior;
- selector precedence cannot be determined;
- constructor factories require runtime modification to test;
- tests require starting CLI or MCP transports;
- environment state cannot be isolated and restored safely;
- `KernelV2` selection is nondeterministic;
- package entry can resolve `KernelV2`;
- type/runtime mismatch reappears;
- a package, dependency, runtime, CLI, MCP, server, graph, memory, fixture,
  schema, workflow, or V5 change becomes necessary;
- targeted or full-suite validation fails.

Use `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH` for a base, branch, or worktree
reality mismatch and `BLOCKED_BY_SCOPE_DRIFT` for an unauthorized changed file.

## Non-Claims

- No tests added in this scope-definition gate.
- No runtime or type code changed.
- No constructor behavior changed.
- No `KernelV2` path changed or deprecated.
- No package entry changed.
- No CLI, MCP, server, graph, or memory behavior changed.
- No graph internals made public.
- No Policy Auditor work performed.

## This Gate Validation

This docs-only gate requires:

```bash
git diff --check
git diff --name-only origin/main...HEAD
git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1a-public-kernel-seam-test-scope.md
```

Tests are not run because this gate adds one task-pack only.

## Next Gates

After independent review, merge, and closeout, the next separately authorized
gate is:

```text
REFACTOR-1B_PUBLIC_KERNEL_SEAM_CONTRACT_TESTS
```

Deferred and not authorized:

```text
REFACTOR-1C_CLI_GRAPH_INTERNAL_COUPLING_SCOPE
```

Do not start either gate automatically.
