# REFACTOR-2B - Application Use-Case Contract

Status: Contract scope for `REFACTOR-2B_APPLICATION_USE_CASE_CONTRACT`.

Repository: `ali-ulu/huqan`

Canonical base: `main @ c873d12d337399494a3357d59a5d15d2386af7ae`

Previous checkpoint: `REFACTOR-2A_CLOSEOUT_AUDIT_GREEN`

Next gate after closeout: `REFACTOR-2C_READ_USE_CASE_EXTRACTION`

## Purpose

This gate defines the application use-case contract that future mechanical
extractions must obey. It does not create use-case modules and does not change
runtime behavior.

The Kernel remains the public facade. Future use cases are internal ownership
boundaries behind that facade unless a later gate explicitly changes exports.

## Contract Rules

- Public Kernel method names, arity expectations, result envelopes, verdicts,
  receipts, and error behavior remain compatible with current source.
- Use cases may depend on ports such as Graph, Memory, Persistence, Audit,
  Capability, and Receipt; surfaces must not depend on Graph internals.
- Use cases must preserve current synchronous/asynchronous behavior for each
  public facade method.
- Graph writes, audit appends, receipt creation, persistence writes, and
  capability execution must remain explicit side effects.
- Compatibility surfaces `kernel.graph` and `kernel.memory` remain observable
  until a later gate explicitly changes that contract.

## Use-Case Contracts

| Use case | Current facade inputs | Current output | Side effects | Required ports | Sync contract | Future extraction owner |
| --- | --- | --- | --- | --- | --- | --- |
| `LearnUseCase` | `learn(text, opts)`, `learnDocument(text, opts)`, `learnFromLLM(text, opts)` | current learn envelope or compatibility object | may write nodes/edges, provenance, receipts, and audit | Graph, Memory, Receipt, Audit, Capability hooks | `learn` sync; async variants remain async | `REFACTOR-2E` before consumer migration |
| `MemoryAdmissionUseCase` | learn/admission options and provenance metadata | current admission decisions embedded in learn result | may reject or admit memory and write receipt metadata | Graph, Memory, Receipt, Policy/admission helpers | sync within current learn path | `REFACTOR-2E` |
| `AskQueryUseCase` | `ask(question, opts)` | current ask envelope | read-only | Graph, Evidence ranking | sync | `REFACTOR-2C` |
| `VerifyClaimUseCase` | `verify(statement, opts)` and `verifyAsync(statement, opts)` | current verify envelope | read-only unless existing source explicitly records metadata | Graph, Trust/Semantic, Contradiction, Provenance | `verify` sync; `verifyAsync` async wrapper | `REFACTOR-2D` |
| `ReasoningUseCase` | `reason(subject, opts)`, `compare(left, right, opts)` | current reason/compare envelopes | read-only | Graph traversal, Evidence | sync | `REFACTOR-2C` |
| `InspectionUseCase` | `detectGaps()`, `detectContradictions()`, `entropy()` | current arrays or number | read-only | Graph statistics and traversal | sync | `REFACTOR-2C` |
| `LifecycleMaintenanceUseCase` | `getPersistenceDescriptor()`, `reload()`, `persist()`, `optimize()`, `consolidate(dryRun)` | current descriptor/result values | reload/save/optimize/consolidate side effects as current source | Graph, Persistence | sync | already covered by 1C2; extraction in `REFACTOR-2C` or later only if behavior remains exact |
| `CliMutationAuditUseCase` | `recordCliMutationAudit(intent)` | current bounded audit result | may append one bounded audit event or return bounded failure | Audit/Graph append | sync only | already covered by 1C3; extraction only with exact contract parity |
| `CapabilityExecutionUseCase` | capability methods and `runCapability(name, input, opts)` | current capability result or error | may execute plugin/tool behavior under current policy | Capability registry, Plugin manager, Workflow runtime | async for `runCapability`; sync for metadata methods | `REFACTOR-2D` or later dedicated gate |
| `EvolutionOrchestrationUseCase` | `dream(opts)`, `selfEvolve(opts)`, `startAutoThink()`, `stopAutoThink()` | current dream/evolution/auto-think outputs | may mutate graph or timers as current source | Graph, Dreamer, Maintenance, Timer | mixed; preserve current behavior | later gate after read/judgment contracts |
| `ReceiptAuditQueryUseCase` | current receipt/audit helper surfaces | current internal structures | read or append only where current source does | Receipt, Audit, Graph | preserve current source | `REFACTOR-2F` |

## Read/Write Classification

Read-only use cases:

- `AskQueryUseCase`
- `ReasoningUseCase`
- `InspectionUseCase`
- read-only parts of `VerifyClaimUseCase`
- read-only receipt/audit query paths

Write-capable use cases:

- `LearnUseCase`
- `MemoryAdmissionUseCase`
- mutation-authorized receipt/audit append paths
- current lifecycle persistence methods
- current evolution orchestration paths
- capability execution only where current source permits side effects

No use case may gain a new write side effect during extraction.

## Error and Envelope Contract

- Existing `_ok()` and `_fail()` envelope shape remains authoritative.
- Existing thrown errors remain thrown where tests currently expect throw
  identity.
- Existing bounded failure return objects remain return objects.
- Extraction must not convert sync throws into async rejections or async
  rejections into sync throws.
- `KernelV2` must delegate to the wrapped Kernel where current source delegates.

## Workspace and Tenant Semantics

Current default workspace behavior remains `default` unless a source path
already passes an explicit workspace value.

This gate does not introduce a tenant model. Any workspace or tenant schema
change requires a separate versioned gate.

## Port Contract

Allowed future ports for discussion:

- `GraphPort`
- `MemoryPort`
- `PersistencePort`
- `AuditPort`
- `ReceiptPort`
- `CapabilityPort`
- `TrustPolicyPort`

These names are contract placeholders. This gate does not create files,
exports, classes, or dependencies.

Ports must not expose mutable Graph collections as a new public API.

## Consumer Migration Order

Future implementation gates must keep this order unless source reality blocks
it:

1. internal Kernel use-case extraction behind the same public facade;
2. contract tests proving facade parity;
3. CLI/MCP/server consumer migration only after facade parity is stable;
4. compatibility surface restriction only after every consumer has a safe path.

## REFACTOR-2C Inputs

`REFACTOR-2C_READ_USE_CASE_EXTRACTION` may only start after this contract is
merged and must begin with tests or source reality for read-only use cases.

Initial candidate read paths:

- `ask`
- `reason`
- `compare`
- `detectGaps`
- `detectContradictions`
- `entropy`
- persistence descriptor read

If extraction requires changing public output, stop and open a contract
reconciliation gate.

## Validation

This docs-only gate requires:

- changed file exactly
  `docs/task-packs/refactor-2b-application-use-case-contract.md`;
- `git diff --check` passes;
- Security Checks passes;
- Benchmark Regression passes.

Local runtime tests are not required for this docs-only contract. If run, they
must have zero failures.

## Stop Conditions

Stop if:

- a use-case contract contradicts current `kernel.js`, `kernel.v2.js`, or
  `kernel.d.ts`;
- a new public API, dependency, package export, schema, verdict, receipt, or
  envelope decision is needed;
- source reality shows a write side effect in a path classified read-only;
- KernelV2 delegation cannot preserve current behavior;
- consumer migration is required to finish the contract.

## Non-Claims

This gate does not claim:

- application use-case files exist;
- `kernel.js` was split;
- `kernel.d.ts` changed;
- surfaces consume use-case APIs;
- Graph, Memory, or Persistence decomposition is complete;
- Policy Auditor is authorized;
- V5, MCP, REST, package, workflow, or Docker behavior changed.
