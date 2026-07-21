# REFACTOR-2E2 - Learn Use-Case Ownership Alignment

Status: Ownership decision only; no runtime or test implementation authorization.

Repository: `ali-ulu/huqan`

Canonical base: `main @ 5ac9b6749c0195ee20eb458f0e693db1aa222f99`

Previous checkpoint: `REFACTOR-2E1_LEARN_MEMORY_ADMISSION_CONTRACT_TESTS_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2E3_LEARN_USE_CASE_EXTRACTION`

## Decision

The current learn mutation algorithm will move behind one internal,
non-exported `LearnUseCase`. `Kernel` remains the only public owner of the
existing learn facade.

The extraction is mechanical. It must not introduce a second public learn
identity, a generic mutation executor, or a new application-level API.

## Public Facade Ownership

`Kernel` continues to own:

- `learn(text, opts)`;
- `learnAsync(text, opts)`;
- `learnDocument(text, opts)`;
- `learnFromLLM(text, opts)`;
- the existing synchronous return boundary of `learn`, `learnDocument`, and
  `learnFromLLM`;
- the compatibility Promise returned by `learnAsync`;
- the `beforeLearn` strict-plugin boundary;
- critical-section entry and release around each public `learn` call;
- current envelope construction through the existing Kernel helpers.

`KernelV2` remains a compatibility facade over Kernel v1. Its post-learn edge
metadata update and its LLM manipulation-risk filtering remain outside the new
use case and must not be normalized away.

## Internal Use-Case Ownership

The future `LearnUseCase` may own only the orchestration currently performed by
`Kernel._learnInternal` after the public `beforeLearn` and lock boundary:

- provenance normalization and warning propagation;
- memory-admission request evaluation and fail-closed review/reject mapping;
- NLP fact extraction;
- existing inline conflict and alternative heuristics;
- Graph node, edge, tag, and derived cross-link writes;
- learn audit-event append and receipt-detail copying;
- the non-strict `afterLearn` plugin event;
- Rust fire-and-forget learn notification;
- Graph save and scheduled maintenance after a successful write;
- the existing learn data, evidence, and metadata passed to Kernel's envelope
  helper.

The use case is an internal collaborator. It must not be exported from the
package root, declared in `kernel.d.ts`, or accepted as a public constructor
option.

## Internal Ports

The extraction may receive narrow internal functions or object references for:

- provenance normalization;
- admission evaluation and receipt-detail mapping;
- NLP extraction, predicate parsing, stop-word checks, and similarity;
- Graph reads and writes;
- learn metadata and edge-evidence construction;
- cross-link creation;
- audit append;
- non-strict plugin emission;
- Rust notification;
- persistence and maintenance scheduling;
- success-envelope construction.

These are dependency seams for testability, not new public interfaces. Ports
must preserve the current call order, thrown errors, best-effort boundaries,
and object identity semantics.

The implementation must reuse existing Kernel, Graph, NLP, plugin, admission,
and envelope helpers directly. It must not add wrapper classes, interface
files, registries, factories, event buses, or dependency containers. A bound
function or existing object reference is preferred; a new abstraction is
allowed only when the mechanical extraction cannot work without it.

## `learnDocument` and `learnFromLLM`

The first extraction must not move the document or LLM loops out of `Kernel`.
Both methods currently call the public `learn` facade for each accepted item,
which preserves per-item plugin, admission, and critical-section behavior.

They may be reduced only after the extracted core is stable, and only if they
continue to call the same public learn boundary. `learnFromLLM` must remain
synchronous, keep its verify-before-learn ordering, and retain its paranoid
failure and plain-summary returns.

## State and Memory Boundary

Canonical learn writes remain Graph-owned. Admission receipts remain discoverable
through Graph audit events. The extraction must not call `kernel.memory` or
`MemoryStore` and must not add a second persistence path.

The legacy clone behavior of `Graph.getEdges()` is preserved. In particular,
the current negation-conflict branch does not gain an in-place stored-edge
downgrade, rollback, or transaction guarantee in this refactor.

## Required Ordering

For a public `learn` call, the observable sequence remains:

1. strict `beforeLearn` plugin processing;
2. critical-section entry;
3. provenance normalization;
4. admission evaluation;
5. fail-closed early audit and return when admission is not allowed;
6. fact extraction and current conflict checks;
7. Graph mutations and per-edge audit append;
8. non-strict `afterLearn` plugin event;
9. Rust fire-and-forget notification;
10. best-effort Graph save and scheduled maintenance when at least one fact was
    learned;
11. result-envelope construction;
12. critical-section release in `finally`.

The current error boundaries also remain:

- provenance and strict-plugin errors propagate;
- non-strict `afterLearn`, audit append, Graph save, Rust, and maintenance
  retain their existing best-effort behavior;
- admission failure remains a bounded review result, not an exception;
- lock release remains guaranteed.

## REFACTOR-2E3 Authorized Shape

A separate exact-base authorization may allow only:

- one internal implementation module under `lib/`;
- `kernel.js` wiring and mechanical code movement;
- the existing 2E1 contract test plus one direct internal-use-case test file if
  needed to prove port ordering and failure isolation.

`REFACTOR-2E3` must leave `kernel.v2.js`, declarations, adapters, CLI, MCP,
server, package files, Graph, and MemoryStore unchanged. If extraction cannot be
completed within that boundary, it stops for rescoping rather than expanding.

## REFACTOR-2E4 Ownership

After 2E3 closeout, a separate gate may align:

- stale `kernel.d.ts` returns for `learnDocument` and `learnFromLLM`;
- internal consumer assertions that depend on the unchanged public facade;
- KernelV2 facade/type parity only where current runtime already provides it.

No consumer should import the internal use case.

## Acceptance Tests

The implementation sequence must keep green:

- `test/refactor-2e-learn-memory-admission-contract.test.js`;
- existing admission, provenance, receipt-index, adapter, Shield, KernelV2,
  concurrency, and persistence regression tests;
- exact public return shapes and sync/async boundaries;
- full suite, Security Checks, Benchmark Regression, and Docker build.

The extraction-specific tests must prove:

- public `learn` invokes the internal use case exactly once after `beforeLearn`;
- lock release occurs on success and thrown failure;
- port call order matches the current source;
- fail-closed admission returns before canonical Graph mutation;
- successful learn saves and schedules maintenance under the same conditions;
- no MemoryStore method is called;
- KernelV2 behavior remains bit-compatible at the public boundary.

## Stop Conditions

Stop if implementation requires:

- a new public method, constructor option, export, type, schema, version,
  dependency, verdict, receipt, or admission state;
- changed sync/async behavior or public return/error shape;
- changed plugin, provenance, admission, audit, receipt, Graph, persistence,
  Rust, maintenance, or conflict semantics;
- MemoryStore integration;
- moving `learnDocument` or `learnFromLLM` behind a path that bypasses public
  `learn` behavior;
- a Graph transaction, rollback, or mutable-edge guarantee not present today;
- changes outside the separately authorized file set.

## Forbidden Scope

- runtime changes in this gate;
- test or declaration changes in this gate;
- public LearnUseCase export;
- Graph, MemoryStore, adapter, Shield, CLI, MCP, server, V5, Policy Auditor,
  workflow, package, dependency, or Docker changes;
- broad parser, conflict, provenance, admission, or persistence redesign;
- REFACTOR-3, REFACTOR-4, or refactor-program closeout claims.

## This Gate Validation

- changed file exactly this task pack;
- `git diff --check` passes;
- Security Checks and Benchmark Regression pass;
- independent read-only review confirms source alignment.

## Non-Claims

- LearnUseCase is not implemented;
- Kernel is not reduced in this gate;
- MemoryStore is not integrated;
- consumers and declarations are not aligned;
- learn behavior is not changed;
- the refactor program is not complete.
