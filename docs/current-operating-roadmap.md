# Current Operating Roadmap

**Live baseline:** `main` at
`26b9b2d4fbd4aa54864fdff2a5fe89a665ab1718` (PR #265 V4-B2 runtime
contract authorization merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The External Client Enablement-0 evidence program is closed, but its HTTP
adapter remains production-unreachable. V4 Workbench runtime-evidence work is
active.

V4-B1 read-only inspector runtime evidence is closed:

- the Trust Receipt Inspector has an authenticated product route and real-server
  smoke;
- the Memory Context Inspector has a durable source contract, read-only adapter,
  bounded route, authenticated server registration, package reachability and
  real SQLite/HTTP smoke.

V4-B2 action/approval evidence is now authorized for one test-only
source-reality gate. V4-B3 receipt-export user flow and V4-B5 final closeout
remain open.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256-#259 | WB2 pure route contract and reconciliation | Helper merged; route unreachable |
| #260-#264 | WB2 server wiring, package reachability, smoke and reconciliation | V4-B1 closed; no action/approval |
| #265 | B2 existing-runtime contract authorization | One test-only source proof; no runtime repair |

## Closed V4-B1 evidence

PR #249 proved:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

Its exact reviewed head `59942569d327249d9319e9228f79be17feeb80ae`
passed Security Checks run `31022647956`, Benchmark Regression run
`31022647907` and full `npm test` job `92363082880` using real `Kernel`,
SQLite-backed `Graph`, real admission and close/reopen evidence.

PR #254 implemented the internal read-only audit adapter. PR #258 implemented
the pure route contract. PR #262 then implemented exactly:

```text
lib/workbench/workbench-read-http-router.js
server.js
package.json
test/v4-wb2d-memory-context-route-smoke.test.js
```

PR #262 exact reviewed head:

```text
fb77b175cf3a44d05ca0cc13b9f172c9ea1d241b
```

Evidence:

- Security Checks run `31031154969`: `SUCCESS`
- Benchmark Regression run `31031154766`: `SUCCESS`
- full `npm test` job `92391978739`: `SUCCESS`
- exact four-file scope
- 114-line bounded Workbench read router
- `server.js` net `-21` lines
- exactly three package allowlist additions
- 239-line real SQLite/HTTP smoke owner
- zero unresolved review threads

PR #262 merged as `5ca853261ae92db27535b6c3b8b1dfa7f31f1e99`.
PR #264 reconciled V4-B1 closure as live main
`c39b75d6e201cc80ef47414c740e87a2e75a19a2`.

The closed B1 boundary registers only
`GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId`, requires
exact raw workspace identity, preserves outer rate limiting and API-key order,
applies `no-store` and `nosniff`, preserves WB3/legacy receipt behavior and
proves read-only product-runtime behavior through real owners.

## Observed V4-B2 source owners

Current source already contains a durable action/approval lifecycle:

- SQLite `tool_approvals` records in `storage.js`;
- pending, executing, approved, rejected and failed states;
- compare-and-swap execution claims and receipt-bound finalization;
- execution lease ownership and expired-lease recovery;
- reviewed and blocked action receipts;
- approval audit event emission;
- `POST /api/ingest` queueing;
- `GET /api/ingest/approvals` unresolved reads; and
- `POST /api/ingest/approvals/:approvalId` decisions/execution.

The repository also contains the reviewed external graph execution chain. Live
source does not yet prove that the existing HTTP decision route calls that
chain. The next test must name the actual caller rather than infer stronger
execution semantics.

## Closed B2 authorization

PR #265 added exactly:

```text
docs/task-packs/v4-b2-action-approval-runtime-contract-authorization.md
```

Exact reviewed head:

```text
940a4c3eb825de83f022e04e2ae73a1c3ba29001
```

Exact-head evidence:

- Security Checks run `31033165001`: `SUCCESS`
- Benchmark Regression run `31033164931`: `SUCCESS`
- exact one-file, 186-line docs scope
- one commit ahead, zero behind, exact merge base
- zero unresolved review threads

PR #265 merged as live main
`26b9b2d4fbd4aa54864fdff2a5fe89a665ab1718`.

## Current gate

This reconciliation opens only:

```text
V4_B2A_INGEST_APPROVAL_RUNTIME_CONTRACT_TESTS
```

The candidate must start from exact canonical main
`26b9b2d4fbd4aa54864fdff2a5fe89a665ab1718` and add exactly:

```text
test/v4-b2a-ingest-approval-runtime-contract.test.js
```

It must use real `server.js`, real `Kernel`, real SQLite-backed `Graph`, real
`AxiomStorage` and loopback HTTP. It may capture the real server-owned kernel
through the existing CLI module-cache test pattern, but it may not replace
approval storage, action execution, receipt, audit or Graph owners.

Required assertions:

1. accepted bounded queue input creates one durable pending `http.ingest`
   approval and no Graph mutation;
2. repeated idempotent queueing does not create a second approval;
3. unresolved reads require authentication and return canonical durable rows;
4. unknown approval identity fails closed;
5. rejection produces a blocked-action receipt and rejection audit without
   Graph mutation;
6. approval claims the exact pending row before action execution;
7. successful approval finalizes the same durable row with matching receipt and
   audit evidence;
8. finalized, failed and executing records cannot be newly approved;
9. expired execution leases become failed / `execution_outcome_unknown` and are
   not automatically retried;
10. workspace, snapshot hash and idempotency identity cannot be replaced by
    decision-request bytes;
11. before/after snapshots identify every mutation and read-only path; and
12. the verdict explicitly names the current route's actual execution caller.

The test must finish with exactly one source-backed verdict:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_SUFFICIENT
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

If a mandatory behavior requires a runtime repair, new route, new state, schema
or caller substitution, the test PR stops with `BLOCKED_GAP` and a separate
product-decision authorization follows.

## Remaining execution order

1. Implement, review, merge and reconcile the exact B2A test-only runtime
   contract gate.
2. If sufficient, authorize the minimum Workbench approval product surface
   using canonical `tool_approvals`; otherwise authorize the proven runtime gap.
3. Complete V4-B3 receipt inspection/export through a real user flow.
4. Complete V4-B5 source/test/CI/package/release closeout.
5. Begin V5 only after V4 closeout and external interoperability entry gates.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- Approval state comes from the existing durable canonical owner.
- No Graph mutation occurs before exact valid approval.
- Missing, rejected, expired and unknown outcomes fail closed.
- Unknown outcomes are not automatically retried or compensated.
- Decision-request bytes do not control workspace, snapshot or receipt meaning.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No production external-client route.
- No production change in the test-only B2A gate.
- No new approval database, queue, status, schema, migration or dependency.
- No Workbench UI, MCP, CLI, retry, repair, compensation, release or deployment
  change.
- No V4-complete or V5-complete claim.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
