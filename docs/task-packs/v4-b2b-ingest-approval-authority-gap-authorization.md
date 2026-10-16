# V4-B2B — Ingest Approval Authority Gap Authorization

## Status

`AUTHORIZED_FOR_EXACT_BASE_IMPLEMENTATION`

This task-pack authorizes one bounded repair for the two source gaps proved by
PR #267. It does not claim that V4-B2 is closed.

## Exact Base

```text
repository: ali-ulu/huqan
base branch: main
canonical main: 6a16a40cd13bf69e125fa30726baa3e0ac085d2b
source proof merge: PR #267 / c3218bb75ff6ad2ec6c4a69c497fb06f9135c8b2
reconciliation merge: PR #297 / fad9cad2f3b88530b78533d1dd268ed5ac9587f0
```

The implementation successor must start from this exact base. A different
`origin/main` requires a new reconciliation before writing code.

## Source-Reality Verdict

PR #267 proved the existing durable HTTP ingest approval lifecycle with real
`server.js`, Kernel, SQLite Graph, AxiomStorage and loopback HTTP. Its exact
verdict is:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

Observed gaps:

1. `buildIngestApprovalSnapshot()` drops caller `workspaceId`; queued approval,
   receipt and audit therefore cannot bind the original workspace.
2. The approval route calls generic `handleIngest()` and records
   `actionOutcome: state_transition_not_asserted`; a plugin return is not an
   authoritative final action outcome.
3. The current manual/decision snapshot is not the reviewed-external envelope,
   plan, candidate, admission and reservation chain required by
   `executeReviewedExternalGraphMutation()`.

## Product Decisions

### 1. Workspace authority

The existing HTTP surface authenticates one shared API key. It does not own a
per-client identity or a trusted caller-to-workspace mapping.

Therefore this repair authorizes **only the canonical `default` workspace**:

- omitted `workspaceId` means canonical `default`;
- exact string `default` is accepted;
- every other supplied workspace value fails closed before queue persistence;
- the canonical workspace is persisted inside the immutable approval snapshot;
- receipt and audit workspace fields are derived from the persisted snapshot,
  never from decision-request bytes and never from a later fallback.

This is a bounded product decision, not a general multi-workspace contract.
Multi-workspace HTTP authority requires a separate authenticated identity and
workspace-binding gate.

### 2. Action scope

The repaired surface remains limited to the current manual and decision ingest
kinds. GitHub, repository, Markdown filesystem, arbitrary tool, external-client
package and reviewed-external graph execution are outside this gate.

### 3. Action-outcome owner

The approved action continues to use the existing `handleIngest()` capability
path. It must not be described as reviewed-external graph execution.

A new bounded Workbench action owner must:

1. receive only the persisted snapshot and server-owned dependencies;
2. validate exact snapshot hash, kind and canonical workspace before execution;
3. capture bounded Graph statistics and audit identity before execution;
4. call `handleIngest()` exactly once after the durable approval claim;
5. validate the exact returned manual/decision result and its admission summary;
6. capture bounded Graph statistics and audit identity after execution;
7. derive a truthful action outcome from the returned admission summary plus
   observed Graph evidence;
8. refuse to finalize an approved receipt when result shape or observed state
   conflicts;
9. classify an uncertain or partially observed result as
   `execution_outcome_unknown`, persist failure, and never retry automatically;
10. expose no raw plugin error, stack, private Graph row or unbounded result.

Permitted bounded outcome vocabulary:

```text
admission_allow_graph_write_observed
admission_allow_no_graph_write_observed
admission_review_no_graph_write_observed
admission_reject_no_graph_write_observed
execution_outcome_unknown
```

`review` or `reject` combined with an observed Graph write is not a successful
approved outcome. A malformed result, contradictory count, missing audit
identity, dependency exception or post-call uncertainty maps to
`execution_outcome_unknown`.

### 4. Receipt and audit binding

A successful reviewed-action receipt must bind at minimum:

- approval ID;
- canonical workspace `default`;
- immutable snapshot hash;
- idempotency identity;
- source kind and bounded source reference;
- exact action owner/version;
- admission outcome;
- bounded before/after Graph evidence hashes or references;
- final action outcome;
- receipt ID and approval audit reference.

Decision-request bytes may select only `approved` or `rejected`. They may not
replace workspace, snapshot, source, action owner, idempotency, receipt meaning
or Graph evidence.

## Thin-Orchestrator Design

`server.js` remains responsible only for outer rate limiting, authentication,
path/method selection, bounded request parsing, dependency wiring and response
writing.

New approval/action domain logic belongs in one bounded module:

```text
lib/workbench/ingest-approval-action.js
```

The module must remain at or below 300 physical lines. It may reuse existing
approval, storage, ingest, receipt and audit primitives; it must not duplicate
their schemas or create a second approval owner.

## Source-Reality Scope Amendment

Live regression source contains an intentional characterization test that now
conflicts with the authorized repair: `test/v4-b2a-ingest-approval-runtime-contract.test.js`
currently requires caller-selected non-default workspace input to queue and
requires the persisted snapshot to omit `workspaceId`. The authorized product
contract requires the opposite. Full regression cannot pass while both contracts
remain active.

This is the necessary sixth owner anticipated by the original stop condition.
The historical B2A test may be changed only to replace superseded gap assertions
with regression assertions for canonical `default` binding and thin delegation.
Its durable queue, idempotency, rejection, lease, unknown-state and no-preapproval-
mutation coverage must remain. No production scope is widened.

## Authorized Implementation Files

The successor may change exactly:

```text
lib/ingest.js
lib/workbench/ingest-approval-action.js
server.js
package.json
test/v4-b2b-ingest-approval-authority-gap.test.js
test/v4-b2a-ingest-approval-runtime-contract.test.js
```

File purposes:

- `lib/ingest.js`: preserve canonical `default` workspace in the hashed
  manual/decision snapshot and reject non-default workspace before persistence.
- `lib/workbench/ingest-approval-action.js`: own bounded decision/execution,
  outcome validation, receipt/audit binding and fail-closed finalization.
- `server.js`: replace inline approval domain logic with thin delegation; net
  physical-line growth must be non-positive.
- `package.json`: add only the new runtime module to the existing `files`
  allowlist; no other metadata changes.
- `test/v4-b2b-ingest-approval-authority-gap.test.js`: real server, Kernel,
  SQLite Graph, AxiomStorage and loopback HTTP acceptance/adversarial evidence.
- `test/v4-b2a-ingest-approval-runtime-contract.test.js`: update only the superseded workspace-omission/direct-inline-
  execution assertions while preserving its durable lifecycle regression coverage.

No seventh file is authorized. Any further owner is a stop condition and
requires another source-backed scope amendment.

## Required Acceptance Evidence

The exact-head test must prove:

1. omitted and exact `default` workspace queue one durable snapshot bound to
   `default`;
2. non-default, blank-conflicting, duplicated or decision-time workspace
   replacement attempts fail closed before persistence or are ignored only
   where the immutable snapshot already owns `default`;
3. repeated idempotent queueing retains one approval and one snapshot hash;
4. rejection emits a blocked receipt and audit bound to the persisted
   workspace/snapshot with zero Graph mutation;
5. approval claims the exact pending row before calling the action owner;
6. `handleIngest()` is invoked exactly once from the bounded action owner;
7. valid manual and decision outcomes map only to the authorized vocabulary;
8. receipt metadata and durable approval context bind the same workspace,
   snapshot, action outcome and evidence references;
9. malformed/hostile result shapes, dependency exceptions and contradictory
   admission/Graph evidence do not finalize as approved;
10. expired lease, CAS loss, unknown record, finalized record and unknown
    outcome remain fail closed and are not retried;
11. decision-request bytes cannot replace workspace, snapshot, source,
    idempotency, action owner or receipt meaning;
12. the route does not import or call `executeReviewedExternalGraphMutation()`;
13. no Graph mutation occurs before exact valid approval;
14. package dry-run contains the new bounded module and does not expand unrelated
    public/runtime files;
15. targeted tests and full `npm test` pass on the exact head.

The implementation candidate must finish with exactly one verdict:

```text
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_BLOCKED_GAP
```

A blocked verdict is acceptable evidence; it must not be hidden by weakening an
assertion or by labelling a plugin return as a committed mutation.

## Forbidden

- No caller-selected non-default workspace.
- No new API key, identity provider, tenant mapping or authorization database.
- No new approval table, state, queue, schema, migration or dependency.
- No direct Graph write from the new module.
- No change to `graph.js`, `kernel.js`, `storage.js`, `lib/approval-flow.js`,
  plugins or reviewed-external owners.
- No direct substitution of `handleIngest()` with
  `executeReviewedExternalGraphMutation()`.
- No automatic retry, compensation or rollback claim after unknown outcome.
- No raw exception/result leakage.
- No Workbench UI, MCP, CLI, external-client route, release or deployment work.
- No V4-complete or V5-complete claim.
- No test skip, assertion weakening or acceptance-vocabulary widening to obtain
  green CI.

## Stop Conditions

Stop without runtime repair if:

- exact `default` workspace cannot be bound before persistence;
- current result/audit evidence cannot distinguish the authorized outcomes;
- the repair requires Graph, Kernel, storage schema or plugin behavior changes;
- successful finalization would require treating a partial or uncertain mutation
  as approved;
- `server.js` cannot remain a thin orchestrator within the authorized files;
- package reachability requires unrelated publication changes;
- exact base or scope changes.

## Validation Commands

```bash
node scripts/agent-context.js
node --test test/v4-b2b-ingest-approval-authority-gap.test.js
node --test test/v4-b2a-ingest-approval-runtime-contract.test.js
npm test
npm pack --dry-run --json --ignore-scripts
git diff --check
git status --short
```

Connector-only work must record local bootstrap, worktree, package dry-run and
Graphify as unverified rather than inventing evidence.

## Definition of Done

- exact six-file scope;
- new module at or below 300 physical lines;
- `server.js` net line growth non-positive;
- canonical default-workspace binding proven;
- truthful bounded action outcomes proven;
- unknown/contradictory outcomes fail closed without retry;
- receipt/audit/snapshot/action evidence agree;
- targeted and full regression pass;
- exact-head Security Checks and Benchmark Regression pass;
- zero unresolved review threads;
- package reachability proven;
- no forbidden claim or scope expansion.
