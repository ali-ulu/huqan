# V4-B2 Action / Approval Runtime Contract Authorization

## Authorization identity

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ c39b75d6e201cc80ef47414c740e87a2e75a19a2`
- Package version: `0.9.1`
- Active roadmap gate: `V4_B2_ACTION_APPROVAL_AUTHORIZATION`
- Authorized successor: `V4_B2A_INGEST_APPROVAL_RUNTIME_CONTRACT_TESTS`
- Scope: one test-only source-reality gate against the existing durable HTTP
  ingest approval lifecycle.

## Source-backed decision

V4-B2 must reuse the existing canonical approval owner rather than create a
parallel Workbench approval model.

Current source already contains:

- the SQLite `tool_approvals` table in `storage.js`;
- pending, executing, approved, rejected and failed lifecycle states;
- exact compare-and-swap claim and finalization methods;
- execution lease ownership and expired-lease recovery;
- receipt-bound approval finalization;
- `APPROVAL_APPROVED` and `APPROVAL_REJECTED` audit emission;
- `POST /api/ingest` queueing;
- `GET /api/ingest/approvals` unresolved-item reading; and
- `POST /api/ingest/approvals/:approvalId` decision/execution handling.

The repository also contains the reviewed external graph execution chain, but
that chain must not be assumed to be the caller used by the current HTTP route.
The next gate characterizes the live route exactly as it exists before any new
Workbench adapter or UI is authorized.

## Exact successor scope

The successor may add exactly:

```text
test/v4-b2a-ingest-approval-runtime-contract.test.js
```

No production file may change.

The candidate must use real `server.js`, real `Kernel`, real SQLite-backed
`Graph`, real `AxiomStorage` and loopback HTTP. A module-cache substitution may
capture the server-owned CLI/kernel as in existing no-mock route tests, but it
may not replace approval storage, action execution, receipt, audit or Graph
owners.

## Required source characterization

The test-only gate must prove or falsify all of the following:

1. `POST /api/ingest` creates one durable pending `http.ingest` approval from
   an accepted bounded snapshot and performs no Graph mutation before review.
2. Repeating the same idempotent request does not create a second approval.
3. `GET /api/ingest/approvals` requires authentication and reads only the
   canonical durable unresolved records.
4. Unknown approval identity fails closed without mutation.
5. Rejection transitions only an exact pending record to rejected, emits a
   blocked-action receipt plus rejection audit evidence, and performs no Graph
   mutation.
6. Approval claims the exact pending row before action execution and cannot be
   claimed concurrently a second time.
7. An approved successful action finalizes the same durable record with its
   receipt; the returned approval, stored approval and audit reference agree.
8. Missing, already-finalized, failed and executing records cannot be treated as
   newly approved.
9. An expired execution lease is recovered to the existing failed /
   `execution_outcome_unknown` state and is not automatically retried.
10. Authentication failure occurs before approval-store or Graph mutation.
11. Workspace, source snapshot hash and idempotency identity remain bound to the
    queued record and cannot be replaced by decision-request bytes.
12. Before/after Graph, audit and approval snapshots prove which exact paths
    mutate and which remain read-only.
13. Existing action receipts retain `actionExecution` and `actionOutcome`
    semantics; the test must not upgrade a lifecycle receipt into a stronger
    canonical-mutation claim.
14. The current HTTP route's real execution caller is named in the verdict. If
    it is not the reviewed external graph execution chain, that limitation must
    remain explicit.

## Required verdict

The test-only gate must finish with exactly one assertion-backed verdict:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_SUFFICIENT
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

`SUFFICIENT` is allowed only if the current route proves bounded action scope,
canonical durable approval state, missing/rejected/expired failure, no
unauthorized mutation and receipt/audit evidence without inventing semantics.

`BLOCKED_GAP` is required if any mandatory behavior needs a new route, state,
schema, receipt meaning or caller substitution. In that case the test PR stops;
it may not repair runtime.

## Acceptance commands

```bash
node --test test/v4-b2a-ingest-approval-runtime-contract.test.js
node --test server.test.js
node --test test/v4-wb2d-memory-context-route-smoke.test.js
node --test test/v4-wb3c-trust-receipt-route-smoke.test.js
npm test
npm pack --dry-run --json --ignore-scripts
git diff --check
git diff --name-only <exact-base>...HEAD
git status --short
```

Acceptance requires:

- exact one-file test scope;
- real SQLite storage and Graph;
- real loopback HTTP;
- zero mutation before valid approval;
- exact durable lifecycle and receipt/audit assertions;
- explicit source-backed verdict;
- targeted and full tests exit `0` with zero failures;
- package surface unchanged;
- exact-head Security Checks and Benchmark Regression succeed; and
- zero unresolved review threads.

## Successor sequence

If current runtime is sufficient:

```text
V4_B2A_INGEST_APPROVAL_RUNTIME_CONTRACT_TESTS
-> V4_B2A_RECONCILIATION
-> V4_B2B_WORKBENCH_APPROVAL_SURFACE_AUTHORIZATION
```

The later Workbench surface must reuse canonical `tool_approvals` records and
may add only the minimum product adapter/route needed to expose bounded reading
and exact decisions. It may not duplicate approval state.

If current runtime has a blocking gap:

```text
V4_B2A_INGEST_APPROVAL_RUNTIME_CONTRACT_TESTS
-> V4_B2A_RECONCILIATION
-> V4_B2_RUNTIME_GAP_PRODUCT_DECISION_AUTHORIZATION
```

## Forbidden scope

- no `server.js`, `storage.js`, Graph, Kernel, action, approval, receipt,
  reviewed-external execution, package or request-guard modification;
- no new approval table, status, queue, schema, migration or dependency;
- no Workbench UI, viewer, MCP or CLI implementation;
- no automatic retry, rollback, compensation or self-approval policy;
- no decision request controlling workspace, snapshot, action payload or
  canonical receipt meaning;
- no external-client production route registration;
- no V4-B3, V4-B5 or V5 work;
- no V4-complete or V5-complete claim.

## Stop conditions

Stop without runtime repair if:

- an accepted bounded queue fixture cannot be produced from current source;
- the route mutates Graph before durable approval;
- rejection or expiry can execute the action;
- identity/workspace/snapshot binding can be replaced at decision time;
- receipt/audit evidence cannot be tied to the exact durable record;
- current action execution is ambiguous or cannot be safely asserted; or
- exact scope cannot remain one test file.

## Connector-only limits

During this authorization, local bootstrap, `node scripts/agent-context.js`,
local tests, worktree state, package dry-run, `git diff --check` and Graphify
were unavailable through the connector. Exact source, Git ancestry, one-file
scope and GitHub CI remain controlling evidence.

## Non-claims

This authorization does not claim that V4-B2 is complete, that the current HTTP
approval route uses the reviewed external graph execution chain, that a
Workbench approval UI exists, or that V4/V5 is complete.
