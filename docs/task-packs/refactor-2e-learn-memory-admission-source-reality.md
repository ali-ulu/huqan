# REFACTOR-2E - Learn and Memory-Admission Source Reality

Status: Source-reality scope; no test or implementation authorization.

Repository: `ali-ulu/huqan`

Canonical base: `main @ cec9ece3f2c92ea9ff26c23d8f47dc03d991ce21`

Previous checkpoint: `REFACTOR-2D8_CAPABILITY_EXECUTION_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2E1_LEARN_MEMORY_ADMISSION_CONTRACT_TESTS`

## Runtime Entry Points

### `learn`

`Kernel.learn(text, opts)` is synchronous. It runs the `beforeLearn` hook,
enters the current critical section, and invokes the existing internal learn
algorithm. That algorithm owns:

- provenance normalization and warnings;
- memory-admission request construction and evaluation;
- fail-closed review/reject handling;
- NLP fact extraction and legacy inline conflict heuristics;
- Graph node, edge, tag, and cross-link writes;
- audit-event append and receipt details;
- Graph save, Rust fire-and-forget notification, and scheduled maintenance;
- the current learn envelope.

`learnAsync` is an async compatibility wrapper around synchronous `learn`; it
does not make the underlying mutation algorithm asynchronous.

### `learnDocument`

`Kernel.learnDocument(text, opts)` is synchronous. It filters eligible lines
and calls `learn` for each line in stable source order. Its default return is a
number. With `returnDetails: true` it returns `{ learned, admissions }`.

### `learnFromLLM`

`Kernel.learnFromLLM(text, opts)` is synchronous despite stale comments that
suggest an async path. It cleans and bounds sentences, optionally calls
synchronous `verify`, then calls `learn` for each accepted sentence. Its legacy
return is `{ learned, skipped, conflicts }`; paranoid mode returns the current
bounded `LLM_DISABLED` failure object.

## Admission, Audit, and Receipt Boundary

Admission is default-on. The only current bypass requires both:

- `admissionRequired: false`; and
- a non-empty `admissionBypassReason`.

Missing, invalid, or non-allow admission must not write canonical Graph state.
Review/reject returns the current `ok: true` learn envelope with zero learned
items and the admission result. The attempt is audited.

Admission receipts are copied into Graph audit-event details. The receipt read
index discovers them from those events. The learn path does not persist through
`kernel.memory` or `MemoryStore`.

## Source-Reality Reconciliation

The older REFACTOR-2B contract listed Memory as a LearnUseCase dependency.
Current canonical source does not use `kernel.memory` in `learn`,
`learnDocument`, `learnFromLLM`, admission, audit, or receipt materialization.
For REFACTOR-2E, source reality is authoritative: MemoryStore must not be added
to the learn path merely to satisfy the older planning label.

MemoryStore decomposition remains a separate REFACTOR-3 concern.

## Conflict and Graph Ownership

Learn conflicts are legacy inline heuristics. `detectClaimConflict` and
`routeCandidateClaim` are separate candidate-claim paths and are not current
owners of `learn` conflict handling.

`Graph.getEdges()` returns clones. The negation branch's direct mutation of a
returned edge does not persist an in-place downgrade of the existing stored
edge. Contract tests must record this source behavior rather than inventing a
rollback or persisted-downgrade guarantee.

## Provenance Reality

Provenance source types are normalized through the existing bounded vocabulary.
Unsupported values may become `system` with warnings in non-strict mode. Strict
provenance errors retain their current thrown-error and audit behavior.

Generated provenance, admission IDs, timestamps, and receipts can contain
volatile fields. Determinism tests must compare canonicalized stable fields or
use fixed inputs; raw output identity is not a valid invariant.

## Consumers

Current production consumers include CLI, MCP direct and approval execution,
HTTP upload, Agent, markdown/GitHub adapters, provenance ingest, Shield, and the
LLM memory plugin. KernelV2 decorates and delegates learning; it is not a second
learn authority.

No consumer migration is authorized until existing entry-point behavior is
contract-tested.

## Type-Surface Gap

`kernel.d.ts` does not accurately describe current runtime returns:

- `learnDocument` returns a number by default or details when requested;
- `learnFromLLM` returns a synchronous plain summary or paranoid failure object.

Type alignment may follow only after runtime behavior is locked. It must not
change runtime shapes or make synchronous methods asynchronous.

## Successor Sequence

1. `REFACTOR-2E1_LEARN_MEMORY_ADMISSION_CONTRACT_TESTS`
2. `REFACTOR-2E2_LEARN_USE_CASE_OWNERSHIP_ALIGNMENT`
3. `REFACTOR-2E3_LEARN_USE_CASE_EXTRACTION`
4. `REFACTOR-2E4_LEARN_CONSUMER_AND_TYPE_ALIGNMENT`
5. `REFACTOR-2E5_LEARN_USE_CASE_CLOSEOUT`

Each successor requires its own exact-base, file-scope, review, merge, and
closeout gate.

## REFACTOR-2E1 Required Characterization

The contract-test gate must cover at least:

- default review with zero canonical Graph writes and an audit attempt;
- approved write with linked provenance, admission, receipt, edge, and audit;
- invalid admission evaluation converted to fail-closed review;
- explicit bypass requiring both opt-out and a non-empty reason;
- `learnDocument` default-review details and stable line order;
- `learnDocument` approved count/details compatibility;
- `learnFromLLM` synchronous default-review and approved behavior;
- no implicit `kernel.memory` write;
- strict-provenance and plugin-hook error propagation;
- conflict behavior based on cloned Graph reads;
- existing adapter/Shield review-result compatibility.

Test ownership should remain bounded. Pure admission decisions stay in
`test/memory-admission-gate.test.js`; receipt-index behavior stays in its
existing tests; MemoryStore primitives stay in `test/memory-store*.test.js`.

## Future Extraction Boundary

A future internal, non-exported LearnUseCase may own the orchestration currently
inside Kernel while using injected internal ports for Graph, NLP, verification,
plugin hooks, audit, save, cross-link, and maintenance.

The Kernel facade, public method names, sync/async boundaries, thrown errors,
return shapes, mutation order, admission policy, bypass rule, receipt/audit
semantics, and consumer behavior must remain unchanged.

## Forbidden Scope

- runtime, test, declaration, consumer, Graph, MemoryStore, package, dependency,
  MCP, server, CLI, V5, Policy Auditor, workflow, or Docker changes;
- new public API, schema, version, envelope, verdict, receipt, admission state,
  bypass, or generic mutation executor;
- routing learn through MemoryStore;
- combining candidate-claim routing with learn conflict handling;
- making learn asynchronous;
- changing provenance vocabulary or normalization.

## Stop Conditions

Stop if a future gate requires:

- changed public return or error behavior;
- changed admission, approval, bypass, audit, receipt, provenance, or mutation
  semantics;
- a new public API, schema/version, dependency, or product decision;
- a transaction/rollback guarantee not present in current source;
- MemoryStore integration or broad Graph redesign;
- changes outside the separately authorized file set.

## This Gate Validation

- changed file exactly this task-pack;
- `git diff --check` passes;
- Security Checks and Benchmark Regression pass.

## Non-Claims

- learn behavior is not changed;
- LearnUseCase is not extracted;
- MemoryStore is not integrated into learning;
- the type-surface gap is not fixed;
- consumers are not migrated;
- REFACTOR-3 and REFACTOR-4 have not started;
- the refactor program is not complete.
