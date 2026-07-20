# REFACTOR-2D4 - Capability Execution Source Reality

Status: Source-reality scope; no implementation authorization.

Repository: `ali-ulu/huqan`

Canonical base: `main @ c11a86fd2f5ee4c3cfd770a1c176cd9566367f55`

Previous checkpoint: `REFACTOR-2D_VERIFY_CLAIM_USE_CASE_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2D5_CAPABILITY_EXECUTION_CONTRACT_TESTS`

## Current Ownership

### Kernel

- `hasCapability` reads the bounded default capability map.
- `enableCapability` rejects unknown names, enables one known capability, and
  conditionally emits `capability:enabled`.
- `requireCapability` returns true or throws the current typed error.
- `listCapabilities` and `getCapability` delegate to PluginManager with current
  empty/null fallbacks.
- async `runCapability` first requires `pluginCapabilities`, then delegates to
  PluginManager and preserves its result or rejection.

### PluginManager

PluginManager owns plugin verification, dependency checks, registration,
capability discovery, lookup, and execution. Its execution algorithm must not
be copied into Kernel or another application module.

### KernelV2

KernelV2 delegates capability state, discovery, and execution to wrapped
Kernel v1 while preserving current missing-system errors and fallbacks.

### Consumers

Current consumers include SDK, ingest, workflow tools, plugins, and tests.
Some compatibility fallbacks call `kernel.plugins.runCapability` directly.
Those fallbacks are observed debt; this gate does not remove them.

## Required Contract

Future capability ownership alignment must preserve:

- known capability names and defaults;
- `CAPABILITY_UNKNOWN` and `CAPABILITY_REQUIRED` error identity and metadata;
- enable-event behavior;
- plugin verification and production enforcement before registration;
- dependency validation and optional-capability warnings;
- capability list/get fallback values;
- async execution and exact result/rejection identity;
- KernelV2 delegation;
- current SDK, ingest, workflow, and plugin behavior;
- fail-closed execution when `pluginCapabilities` is disabled.

It must not:

- bypass Kernel capability policy;
- weaken plugin hash/signature enforcement;
- expose PluginManager as a new public API;
- add a generic ungoverned executor;
- change plugin manifests, capability names, or command mapping;
- combine capability execution with VerifyClaimUseCase;
- migrate consumers before facade parity is contract-tested.

## Source Conflict To Resolve Before Migration

SDK and workflow compatibility paths may fall back directly to
`kernel.plugins.runCapability`. The contract-test gate must classify each
fallback as required compatibility or removable bypass. No callsite migration
is authorized until that inventory is exact.

## Successor Sequence

1. `REFACTOR-2D5_CAPABILITY_EXECUTION_CONTRACT_TESTS`
2. `REFACTOR-2D6_CAPABILITY_EXECUTION_OWNERSHIP_ALIGNMENT`
3. `REFACTOR-2D7_CAPABILITY_CONSUMER_MIGRATION`
4. `REFACTOR-2D8_CAPABILITY_EXECUTION_CLOSEOUT`

## Allowed Scope

Exactly this task-pack.

## Forbidden Scope

- runtime, declaration, test, fixture, plugin, manifest, schema, package,
  dependency, workflow, Docker, MCP, server, V5, or Policy Auditor changes;
- consumer migration;
- new capability, command, executor, verdict, receipt, or envelope.

## Stop Conditions

Stop if a future gate requires a new public API, capability name, dependency,
schema/version decision, weaker plugin verification, or changed async/error
behavior.

## Validation

- changed file exactly this task-pack;
- `git diff --check` passes;
- Security Checks and Benchmark Regression pass.

## Non-Claims

- capability execution was not refactored;
- direct compatibility fallbacks were not removed;
- plugin security was not changed;
- REFACTOR-3 and REFACTOR-4 have not started;
- the refactor program is not complete.
