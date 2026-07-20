# REFACTOR-2D6 - Capability Execution Ownership Alignment

Status: Ownership decision; no runtime implementation authorization.

Repository: `ali-ulu/huqan`

Canonical base: `main @ 3124fdcedc980ca45ea009b81ab5f847b3cdd2a6`

Previous checkpoint: `REFACTOR-2D5_CAPABILITY_EXECUTION_CONTRACT_TESTS_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2D7_CAPABILITY_CONSUMER_MIGRATION`

## Decision

`Kernel.runCapability(name, input, opts)` is the governed capability-execution
owner. It must enforce the existing `pluginCapabilities` requirement before
delegating execution to PluginManager.

PluginManager continues to own plugin verification, registration, dependency
checks, capability lookup, and the execution algorithm. Alignment must not copy
that algorithm into Kernel or another module.

KernelV2 remains a compatibility wrapper and delegates capability state,
discovery, and execution to its wrapped Kernel v1 instance.

## Consumer Classification

### Workflow tools

The current resolver prefers `kernel.plugins.runCapability` over
`kernel.runCapability`. With a real Kernel this is a reachable policy bypass,
not required compatibility. `REFACTOR-2D7` must make workflow capability calls
prefer the governed Kernel facade and must not fall back to PluginManager when
that facade is present.

Workflow result metadata must describe the runner that actually executed. It
must not claim `kernel.runCapability` when a compatibility runner was selected.

### SDK

The SDK already prefers `kernel.runCapability`. Its direct PluginManager path
is retained only as compatibility for bounded Kernel-like legacy objects that
do not expose the Kernel facade. It must never outrank an available
`kernel.runCapability` method.

Removing the SDK fallback requires a separate compatibility and consumer
inventory decision; it is not authorized by this sequence.

### Ingest and other callers

Callers that already route through the SDK or Kernel facade retain their
current behavior. Direct PluginManager consumers must be inventoried before
any migration; tests and PluginManager-internal execution are not automatically
classified as public consumer bypasses.

## Type-Surface Alignment

Runtime Kernel and KernelV2 already expose these methods:

- `hasCapability(name)`;
- `enableCapability(name)`;
- `requireCapability(name)`;
- `listCapabilities()`;
- `getCapability(name)`;
- async `runCapability(name, input, opts)`.

Their declaration files do not currently expose the complete runtime surface.
Runtime `KernelOptions` also already accepts a partial `capabilities` map, which
is absent from `kernel.d.ts`.
`REFACTOR-2D7` may align `kernel.d.ts` and `kernel.v2.d.ts` to existing runtime
behavior, including this existing constructor option. Type alignment must not
create a new method, capability, result envelope, error, or execution path.
Raw `plugins` access must not be added to declarations as a public mutable
manager surface.

## Required Invariants

- known capability names and defaults remain unchanged;
- `CAPABILITY_UNKNOWN` and `CAPABILITY_REQUIRED` identity and metadata remain
  unchanged;
- disabled `pluginCapabilities` fails before PluginManager execution;
- enable-event behavior remains unchanged;
- PluginManager verification and production-signing enforcement remain intact;
- dependency validation and optional-capability warnings remain intact;
- list/get fallback values remain `[]` and `null`;
- async result and rejection identity remain unchanged;
- KernelV2 delegation preserves result and rejection identity;
- no mutable PluginManager collection becomes public;
- no new generic executor or fail-open fallback is introduced.

## REFACTOR-2D7 Allowed Scope

The implementation gate may change only the minimum files proven necessary by
the reviewed source and test matrix:

- `workflow-tools.js`;
- `workflow-tools.test.js`;
- `test/kernel-capability-execution-contract.test.js`;
- `kernel.d.ts`;
- `kernel.v2.d.ts`;
- existing facade/type-parity contract tests, only if required.

Exact files must be frozen in the separate implementation authorization. A
file being listed here does not require it to change.

## Forbidden Scope

- Kernel or KernelV2 runtime method changes unless source evidence proves the
  migration cannot use their existing facade;
- PluginManager execution, verification, registration, manifest, or dependency
  behavior changes;
- removal of the SDK compatibility fallback;
- new capability names, commands, schemas, versions, dependencies, envelopes,
  verdicts, receipts, or public APIs;
- ingest, MCP, server, CLI, V5, Policy Auditor, package, workflow, or Docker
  changes;
- broad plugin or application-boundary redesign.

## Acceptance Criteria For REFACTOR-2D7

1. A real Kernel workflow call reaches `Kernel.runCapability` exactly once.
2. Disabled `pluginCapabilities` produces the existing fail-closed error before
   any PluginManager execution.
3. Enabled execution preserves exact arguments, result identity, and rejection
   identity.
4. Workflow metadata identifies the actual selected runner.
5. SDK Kernel-first behavior and bounded legacy fallback remain unchanged.
6. KernelV2 delegation remains unchanged.
7. Declarations describe only the six capability methods and partial
   `KernelOptions.capabilities` input already present at runtime; they do not
   expose raw PluginManager ownership.
8. Targeted, related, full-suite, Security Checks, Benchmark Regression, and
   Docker validation pass.
9. An independent read-only review finds no policy bypass or scope drift.

## Stop Conditions

Stop if alignment requires:

- a new public API or capability name;
- changed plugin verification or production enforcement;
- changed async, result, rejection, or error behavior;
- removal of a compatibility fallback without a complete consumer inventory;
- schema/version, dependency, package, MCP, server, CLI, or V5 changes;
- more than the separately authorized implementation file set.

## This Gate Validation

- changed file exactly this task-pack;
- `git diff --check` passes;
- Security Checks and Benchmark Regression pass.

## Non-Claims

- workflow capability execution is not yet migrated;
- the reachable workflow policy bypass is not yet closed;
- SDK compatibility fallback is not removed;
- capability declarations are not yet aligned;
- PluginManager is not a new public API;
- REFACTOR-3 and REFACTOR-4 have not started;
- the refactor program is not complete.
