# REFACTOR-2A - Kernel Responsibility Inventory

Status: Scope and inventory for `REFACTOR-2A_KERNEL_RESPONSIBILITY_INVENTORY`.

Repository: `ali-ulu/huqan`

Canonical base: `main @ bae86b376336614ec2f50662f8be219e1d79ec00`

Previous checkpoint: `REFACTOR-1C4_CLOSEOUT_AUDIT_GREEN`

Next authorized gate after merge: `REFACTOR-2B_APPLICATION_USE_CASE_CONTRACT`

## Purpose

`REFACTOR-2` decomposes Kernel application responsibilities without changing
the public Kernel facade, runtime behavior, envelopes, receipts, verdicts, or
persistence semantics.

This gate is inventory only. It records current Kernel responsibility ownership
from source reality so later use-case contracts can be written without
inventing behavior.

## Source Authorities

- `kernel.js`
- `kernel.v2.js`
- `kernel.d.ts`
- `cli.js`
- `mcpServer.js`
- `docs/refactor/kernel-facade-contract.md`
- `docs/task-packs/refactor-1c4a-mechanical-cli-migration-scope-freeze.md`
- `test/kernel-facade-contract.test.js`
- `test/kernel-lifecycle-maintenance-seam-contract.test.js`
- `test/kernel-cli-audit-seam-contract.test.js`

## Kernel Responsibility Inventory

| Responsibility | Current source owner | Public or internal | Current notes | Candidate future owner |
| --- | --- | --- | --- | --- |
| constructor/bootstrap | `Kernel` constructor in `kernel.js` | public construction | creates Graph, MemoryStore, plugins, capabilities, agent state, and optional graph load | Kernel facade/bootstrap module |
| graph ownership | `this.graph` in `kernel.js` | compatibility surface | observable today; direct mutation is not a new stable extension API | graph port owned by application use cases |
| memory ownership | `this.memory` in `kernel.js` | compatibility surface | observable today; `memory.close()` is part of current type surface | memory port owned by application use cases |
| persistence descriptor | `getPersistenceDescriptor()` | public seam | returns memory path and derived DB path behavior | lifecycle use case |
| reload | `reload()` | public seam | delegates to Graph reload/load behavior without arguments | lifecycle use case |
| persist | `persist()` | public seam | delegates to Graph save behavior without arguments | lifecycle use case |
| optimize | `optimize()` | public seam | delegates to Graph optimize result and error identity | lifecycle use case |
| CLI mutation audit | `recordCliMutationAudit()` | public seam | bounded, synchronous CLI audit intent mapping | audit use case |
| learn/admission | `learn()`, `_learnInternal()`, admission helpers | public facade plus internals | owns extraction, admission, graph writes, provenance, receipts, and learn envelopes | learn and memory-admission use cases |
| document/LLM learn | `learnDocument()`, `learnFromLLM()` | public facade | compatibility paths for batch and LLM-derived learning | learn use case |
| ask/read | `ask()` | public facade | reads graph evidence and returns ask envelope | read/query use case |
| verify/judgment | `verify()`, `_verifyInternal()` | public facade plus internals | verifies claims with semantic, contradiction, risk, and trace behavior | verification use case |
| reasoning | `reason()`, `compare()`, path helpers | public facade plus internals | graph traversal and explanation generation | reasoning use case |
| contradiction/gap detection | `detectContradictions()`, `detectGaps()` | public facade | graph analysis and compatibility outputs | inspection use case |
| entropy/consolidation | `entropy()`, `consolidate()` | public facade | graph metric and cleanup behavior | maintenance use case |
| dream/self evolution | `dream()`, `selfEvolve()`, auto-think methods | public facade | orchestration over dream, maintenance, and graph mutation behavior | evolution orchestration use case |
| capabilities/plugins | capability methods, `runCapability()`, `usePlugin()` | public and internal | plugin execution, capability checks, and runtime tool routing | capability/use-case boundary |
| approval/candidate claims | candidate claim and approval helpers | mixed | current candidate and conflict helpers remain inside Kernel | approval and claim use cases |
| receipt/audit append | `_appendAuditEvent()` and receipt helpers | internal | graph audit write and receipt details remain internal except bounded CLI seam | receipt/audit use case |
| signing/verification V5 links | V5 helper integration points | internal/adjacent | no new V5 capability is authorized here | later V5-specific gate only |
| compatibility aliases | `KernelV2` wrapper/delegations | public alternate constructor | must delegate rather than invent new behavior unless separately authorized | facade compatibility layer |

## Current Consumer Map

| Consumer | Current Kernel dependency | Boundary status |
| --- | --- | --- |
| package entry | `require('..')` resolves to `kernel.js` | frozen by facade contract |
| CLI | uses Kernel facade, lifecycle seams, audit seam, and one approved `graph.getStats()` read | 1C4 closed; no inventoried direct Graph access remains |
| MCP | selects Kernel or KernelV2 by exact `AXIOM_KERNEL_VERSION=v2` | constructor variant contract remains active |
| REST/server | consumes Kernel runtime behavior indirectly | no migration authorized in this gate |
| tests | may observe `kernel.graph` compatibility surfaces | not evidence of production direct Graph access |
| KernelV2 | wraps Kernel v1 and delegates lifecycle/audit seams | must not become a separate behavior authority |

## Candidate Use-Case List for REFACTOR-2B

- `LearnUseCase`
- `MemoryAdmissionUseCase`
- `VerifyClaimUseCase`
- `AskQueryUseCase`
- `ReasoningUseCase`
- `LifecycleMaintenanceUseCase`
- `CliMutationAuditUseCase`
- `ReceiptQueryUseCase`
- `CapabilityExecutionUseCase`
- `EvolutionOrchestrationUseCase`

Names are placeholders for contract discussion only. This gate does not create
modules or choose final filenames.

## No-Change List

The following must remain unchanged through this inventory gate:

- public Kernel constructor identity
- `kernel.d.ts`
- `kernel.js`
- `kernel.v2.js`
- `cli.js`
- package exports and package metadata
- verdict, receipt, and envelope shapes
- persistence path behavior
- Graph, MemoryStore, SQLite, and file formats
- V5 verification/signing behavior
- MCP/server/REST behavior
- Policy Auditor status

## REFACTOR-2B Input Questions

`REFACTOR-2B` must answer these before implementation:

- Which use cases are allowed to write to Graph?
- Which use cases are read-only?
- Which use cases may issue or query receipts?
- Which ports are synchronous and which may be asynchronous?
- How are workspace/tenant inputs represented without changing current shapes?
- Which errors are returned in envelopes and which are thrown?
- Which compatibility surfaces stay observable during migration?
- Which consumers must migrate first: CLI, MCP, REST/server, or tests?

## Validation

This docs-only gate requires:

- changed file exactly `docs/task-packs/refactor-2a-kernel-responsibility-inventory.md`;
- `git diff --check` passes;
- Security Checks passes;
- Benchmark Regression passes.

Local runtime tests are not required for this docs-only inventory. If run, they
must have zero failures.

## Stop Conditions

Stop if:

- source reality contradicts the current facade contract;
- `kernel.d.ts` and runtime surface require code alignment;
- an implementation decision is required to finish the inventory;
- a new public API, schema, dependency, or package export is needed;
- a consumer map cannot be written without inspecting unsupported private
  behavior.

## Non-Claims

This gate does not claim:

- `kernel.js` was refactored;
- application use cases exist;
- Graph/Memory/Persistence decomposition is complete;
- all consumers use application use cases;
- Policy Auditor is authorized;
- V5, REST, MCP, package, or workflow behavior changed.
