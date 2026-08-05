# Current Operating Roadmap

**Live baseline:** `main` at
`c3218bb75ff6ad2ec6c4a69c497fb06f9135c8b2` (PR #267 V4-B2A runtime
contract proof merge).

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

V4-B2 action/approval evidence is **not closed**. PR #267 proved the current
durable approval lifecycle and produced the exact verdict:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

V4-B3 receipt-export user flow and V4-B5 final closeout remain open.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256-#259 | WB2 pure route contract and reconciliation | Helper merged; route unreachable |
| #260-#264 | WB2 server wiring, package reachability, smoke and reconciliation | V4-B1 closed; no action/approval |
| #265-#266 | B2 existing-runtime contract authorization and reconciliation | One test-only source proof; no runtime repair |
| #267 | B2A real-server/SQLite approval lifecycle proof | Existing lifecycle is bounded but insufficient for V4-B2 closure |

## Closed V4-B1 evidence

PR #249 proved:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

PR #254 implemented the internal read-only audit adapter. PR #258 implemented
the pure route contract. PR #262 registered the bounded Workbench route and
proved it with real Kernel, SQLite Graph and loopback HTTP. PR #264 reconciled
V4-B1 closure.

Controlling exact-head evidence for PR #262:

- head `fb77b175cf3a44d05ca0cc13b9f172c9ea1d241b`;
- Security Checks run `31031154969`: `SUCCESS`;
- Benchmark Regression run `31031154766`: `SUCCESS`;
- full `npm test` job `92391978739`: `SUCCESS`;
- exact four-file scope and zero unresolved review threads.

## V4-B2A observed source contract

Current source owns a durable action/approval lifecycle through SQLite
`tool_approvals`:

- pending, executing, approved, rejected and failed states;
- compare-and-swap execution claims and receipt-bound finalization;
- execution leases and expired-lease recovery;
- reviewed and blocked action receipts;
- approval audit event emission;
- `POST /api/ingest` queueing;
- `GET /api/ingest/approvals` unresolved reads; and
- `POST /api/ingest/approvals/:approvalId` decisions/execution.

PR #267 added exactly:

```text
test/v4-b2a-ingest-approval-runtime-contract.test.js
```

Exact reviewed head:

```text
5b2d8d06f38c224503c2e0db69013383eb6ca43b
```

Exact-head evidence:

- Security Checks run `31033964276`: `SUCCESS`;
- Benchmark Regression run `31033964056`: `SUCCESS`;
- one commit ahead, zero behind at review time;
- exactly one 277-line test file;
- real `server.js`, Kernel, SQLite Graph, AxiomStorage and loopback HTTP;
- no production/runtime file change;
- zero unresolved review threads.

PR #267 merged as live main
`c3218bb75ff6ad2ec6c4a69c497fb06f9135c8b2`.

## Proven B2 gaps

### 1. Workspace authority is not durably bound

The request may contain `workspaceId`, but `buildIngestApprovalSnapshot()`
builds its persisted payload through `buildCapabilityPayload()` and the
manual/decision payload shape omits workspace identity. The queued snapshot
therefore cannot bind the original caller workspace.

The approval decision route then constructs rejection/approval receipts and
audit events with hard-coded `default` workspace identity. Decision-request
workspace bytes are ignored, which prevents request-time replacement but does
not establish the correct authoritative workspace.

### 2. Successful plugin return is not a canonical action outcome

The approval route calls:

```text
handleIngest({ kernel, data: snapshot.payload, ... })
```

The reviewed receipt explicitly reports:

```text
actionExecution: plugin_execution_returned
actionOutcome: state_transition_not_asserted
```

That is an honest lifecycle receipt, not proof of a bounded canonical Graph
mutation or other authoritative product action outcome.

### 3. The reviewed external graph owner cannot be relabelled into this route

The repository contains `executeReviewedExternalGraphMutation()`, but that
owner requires the complete reviewed external chain: persistent reviewed source
envelope, execution plan, candidate plan, admission ticket, reservation,
trusted workspace/requester/reviewer identities and exact SQLite state.

The current manual/decision `/api/ingest` snapshot does not contain that chain.
A direct call substitution or naming change would manufacture authority rather
than preserve it.

## Current gate

This reconciliation opens only:

```text
V4_B2B_INGEST_APPROVAL_AUTHORITY_GAP_AUTHORIZATION
```

The next candidate must start from exact canonical main
`c3218bb75ff6ad2ec6c4a69c497fb06f9135c8b2` and add exactly:

```text
docs/task-packs/v4-b2b-ingest-approval-authority-gap-authorization.md
```

The authorization must decide, before any runtime change:

1. which server-owned identity establishes the canonical workspace for the
   existing authenticated HTTP approval surface;
2. whether the approved action remains bounded manual/decision ingest or a new
   exact Workbench action type is required;
3. which existing owner can prove the final state transition without treating
   a generic capability/plugin return as authority;
4. the minimum extracted module that keeps `server.js` a thin orchestrator;
5. the exact runtime and test file scope for the successor;
6. receipt and audit fields required to bind approval, workspace, snapshot,
   action owner and final outcome;
7. fail-closed behavior for missing/mismatched workspace, unknown action
   outcome, lease loss, result tamper and finalization conflict; and
8. whether the proven gap can be repaired without new state, schema, queue,
   retry or compensation semantics.

The authorization must stop if the product identity/workspace contract cannot
be established from a server-owned source.

## Remaining execution order

1. Authorize the exact B2B workspace/action-outcome repair from current main.
2. Reconcile that authorization before implementation.
3. Implement and falsify the minimum bounded repair in a separate PR.
4. Reconcile V4-B2 only after exact-head runtime, receipt, audit and smoke
   evidence.
5. Complete V4-B3 receipt inspection/export through a real user flow.
6. Complete V4-B5 source/test/CI/package/release closeout.
7. Begin V5 only after V4 closeout and external interoperability entry gates.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- Approval state comes from the existing durable canonical owner.
- No Graph mutation occurs before exact valid approval.
- Missing, rejected, expired and unknown outcomes fail closed.
- Unknown outcomes are not automatically retried or compensated.
- Decision-request bytes do not control workspace, snapshot or receipt meaning.
- Generic plugin completion is not a canonical action outcome.
- The reviewed external graph owner is used only with its complete validated
  input chain.
- New domain logic does not accumulate in `server.js`.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No production external-client route.
- No runtime repair in this reconciliation.
- No direct replacement of `handleIngest()` with
  `executeReviewedExternalGraphMutation()`.
- No caller-controlled workspace authority.
- No new approval database, queue, status, schema, migration or dependency.
- No automatic retry, repair or compensation.
- No Workbench UI, MCP, CLI, release or deployment change.
- No V4-complete or V5-complete claim.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
