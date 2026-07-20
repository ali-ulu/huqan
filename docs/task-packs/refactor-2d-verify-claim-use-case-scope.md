# REFACTOR-2D - Verify Claim Use-Case Scope

Status: Scope definition for `REFACTOR-2D_VERIFY_CLAIM_USE_CASE`.

Repository: `ali-ulu/huqan`

Canonical base: `main @ 07f62cd3ce9677715d6660093f9a7a0ebf6f800d`

Previous checkpoint: `REFACTOR-2C_READ_USE_CASE_EXTRACTION_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2D1_VERIFY_CLAIM_CONTRACT_TESTS`

## Purpose

This gate records the current verify ownership boundary before any mechanical
application-layer extraction. It does not change runtime behavior.

`Kernel` remains the public facade. `VerifyService` already owns the verify
algorithm and contradiction inspection. Future work must align that existing
service with the application use-case boundary instead of copying its logic
into a second implementation.

Capability execution is not part of this gate. Although REFACTOR-2B listed it
as a possible REFACTOR-2D-or-later concern, its plugin-policy and asynchronous
execution boundary requires a separate scope after verify closeout.

## Current Source Reality

### Kernel v1

- `Kernel.verify(statement, opts)` preserves the current public synchronous
  envelope and lock behavior, then routes to `_verifyInternal`.
- `_verifyInternal(statement, opts)` delegates to
  `VerifyService.verify(statement, opts)`.
- `Kernel.verifyAsync(statement, opts)` remains an async wrapper over the
  public `verify` method.
- `Kernel.detectContradictions(subject, workspaceId)` delegates to
  `VerifyService.detectContradictions(subject, workspaceId)`.
- Existing private compatibility helpers still delegate to private
  `VerifyService` helpers. This scope does not make those helpers public.

### Kernel v2

`KernelV2.verify` adds its current parsing, risk, and detail behavior around
the wrapped Kernel v1 result. It is not a direct one-line delegation and must
not be replaced by a simpler call unless exact output parity is proven.

`KernelV2.detectContradictions()` delegates to the wrapped Kernel v1 surface.

### Verify service

`lib/verify.js` is the current algorithm owner for:

- statement verification;
- semantic and contradiction evidence;
- entity-resolution metadata;
- reasoning trace generation;
- contradiction detection;
- current verdict and confidence computation.

This gate does not split or redesign that algorithm.

## Required Contract

The future `VerifyClaimUseCase` boundary must preserve:

- public method names and synchronous/asynchronous behavior;
- exact success and failure envelope shapes;
- verdict, confidence, evidence, metadata, and reasoning-trace semantics;
- workspace and domain option propagation;
- entity-resolution metadata without graph mutation;
- contradiction evidence and fail-closed behavior;
- thrown error identity where current tests expect a throw;
- KernelV2's current risk/detail additions;
- read-only graph behavior for verify and contradiction inspection.

The boundary must not:

- duplicate the verify algorithm;
- expose `VerifyService` as a new package export;
- expose private helper methods;
- introduce a new verdict, reason, receipt, schema, or envelope;
- convert synchronous verification into an asynchronous API;
- add graph, persistence, audit, receipt, network, or filesystem writes;
- combine capability execution with claim verification.

## Implementation Shape

The preferred mechanical implementation is:

1. preserve `VerifyService` as the algorithm owner;
2. introduce at most one internal application use-case boundary that delegates
   to the existing service;
3. keep `Kernel` as the public facade;
4. keep KernelV2 behavior unchanged and routed through its wrapped Kernel;
5. add contract tests before or with the runtime alignment;
6. remove no compatibility surface during this gate.

If the extra use-case layer would only rename `VerifyService` without creating
a meaningful ownership seam, stop and document the existing service as the
accepted use-case implementation instead of adding a pass-through module.

## Test Ownership

The contract-test gate must inventory and preserve at least:

- `kernel.test.js` verify and contradiction behavior;
- `test/verify-semantic.integration.test.js`;
- `test/verify-adversarial.integration.test.js`;
- `test/verify-canonical-lookup.test.js`;
- `test/verify-entity-resolution.test.js`;
- `test/verify-reasoning-trace.integration.test.js`;
- `kernel.v2.test.js` verify behavior;
- `test/kernel-concurrency-path.test.js` sync/async and lock behavior;
- facade and declaration parity tests.

Future tests must prove delegation without replacing the existing semantic,
adversarial, and integration suites with mocks.

## Successor Gates

The required sequence is:

1. `REFACTOR-2D1_VERIFY_CLAIM_CONTRACT_TESTS`
2. `REFACTOR-2D2_VERIFY_CLAIM_OWNERSHIP_ALIGNMENT`
3. `REFACTOR-2D3_VERIFY_CLAIM_CLOSEOUT`
4. `REFACTOR-2D4_CAPABILITY_EXECUTION_SOURCE_REALITY`

Each successor requires its own exact-base authorization and closeout.

## Allowed Scope For This Gate

Exactly this file:

`docs/task-packs/refactor-2d-verify-claim-use-case-scope.md`

## Forbidden Scope

- `kernel.js`, `kernel.v2.js`, or declaration changes;
- `lib/verify.js` changes;
- tests or fixtures;
- capability or plugin behavior;
- Graph, Memory, Persistence, Audit, or Receipt decomposition;
- package, dependency, schema, workflow, Docker, MCP, server, or V5 changes;
- Policy Auditor or post-refactor product work.

## Stop Conditions

Stop if:

- current verify behavior contradicts this scope;
- a new public API or package export is required;
- output, verdict, receipt, reason, or envelope changes are required;
- VerifyService ownership cannot be preserved without algorithm duplication;
- KernelV2 parity requires a behavior decision;
- capability execution must change to complete verify alignment;
- verification is found to mutate graph or persistence state.

## Validation

- changed file is exactly this task-pack;
- `git diff --check` passes;
- Security Checks passes;
- Benchmark Regression passes;
- no runtime implementation is claimed.

## Non-Claims

This gate does not claim:

- VerifyClaimUseCase runtime code exists;
- VerifyService was refactored;
- verify behavior or output changed;
- capability execution was extracted;
- Graph, Memory, or Persistence decomposition started;
- Policy Auditor is authorized;
- the refactor program is complete.
