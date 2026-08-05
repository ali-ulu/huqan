# Current Operating Roadmap

**Live baseline:** `main` at
`725dbba334a786f051d5753764088e3b5338c54c` (PR #301 exact-identifier
hardening merge after the V4-B2B authorization).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The External Client Enablement-0 evidence program is closed, but its HTTP
adapter remains production-unreachable. V4 Workbench runtime-evidence work is
active.

V4-B1 read-only inspector runtime evidence is closed. V4-B2 action/approval
evidence is open and has an exact-base implementation authorization. V4-B3
receipt-export user flow and V4-B5 final closeout remain open.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256-#259 | WB2 pure route contract and reconciliation | Helper merged; route unreachable |
| #260-#264 | WB2 server wiring, package reachability, smoke and reconciliation | V4-B1 closed; no action/approval |
| #265-#267 | B2 existing-runtime authorization and real-server/SQLite characterization | Existing lifecycle bounded but insufficient |
| #297 | B2A blocked-gap reconciliation | Opened only exact authority-gap authorization |
| #298-#299 | B2B authority-gap authorization and reconciliation | No runtime change; exact five-file successor only |
| #300, #302, #301 | Unrelated issue fixes and ADR cleanup | No authorized V4-B2B implementation file changed |

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

PR #267 exact reviewed head
`5b2d8d06f38c224503c2e0db69013383eb6ca43b` passed Security Checks run
`31033964276` and Benchmark Regression run `31033964056`. It added exactly one
277-line test file and proved the existing lifecycle using real `server.js`,
Kernel, SQLite Graph, AxiomStorage and loopback HTTP.

Its controlling verdict is:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

PR #267 merged as
`c3218bb75ff6ad2ec6c4a69c497fb06f9135c8b2`.

## Proven B2 gaps

### 1. Workspace authority is not durably bound

The request may contain `workspaceId`, but `buildIngestApprovalSnapshot()`
builds its persisted payload through `buildCapabilityPayload()` and the
manual/decision payload shape omits workspace identity. The queued snapshot
therefore cannot bind the original workspace.

The approval route constructs rejection/approval receipts and audit events with
hard-coded `default`. Decision-request workspace bytes are ignored, which
prevents late replacement but does not establish the authoritative workspace.

### 2. Successful plugin return is not a bounded final action outcome

The approval route calls:

```text
handleIngest({ kernel, data: snapshot.payload, ... })
```

The reviewed receipt explicitly reports:

```text
actionExecution: plugin_execution_returned
actionOutcome: state_transition_not_asserted
```

That is honest lifecycle evidence, not proof of an exact action outcome.

### 3. Reviewed external graph execution is a different contract

`executeReviewedExternalGraphMutation()` requires the complete reviewed source
envelope, execution plan, candidate plan, admission ticket, reservation,
trusted workspace/requester/reviewer identities and exact SQLite state. The
current manual/decision `/api/ingest` snapshot does not contain that chain.
Direct substitution or renaming would manufacture authority.

## Authorized product contract

PR #298 added the controlling task-pack:

```text
docs/task-packs/v4-b2b-ingest-approval-authority-gap-authorization.md
```

Exact reviewed head:

```text
71019bc0faa9171372e0461b330d8ec70bf74c77
```

Exact-head evidence:

- Security Checks run `31039238175`: `SUCCESS`;
- Benchmark Regression run `31039236945`: `SUCCESS`;
- one commit ahead, zero behind at review time;
- exactly one 266-line task-pack;
- zero unresolved review threads.

PR #298 merged as
`f765ddd687e06823c45dba5d498ec6543234eed8`; PR #299 reconciled it as
`d8f8a54a1e364c89c30f36da0643e908751f0762`.

The authorized product decisions are:

1. the shared API-key HTTP surface supports only canonical workspace `default`;
2. omitted or exact `default` is accepted; every other supplied workspace fails
   closed before queue persistence;
3. the canonical workspace is persisted in the immutable snapshot and is the
   sole source for receipt and audit workspace binding;
4. manual and decision ingest remain the only action kinds;
5. a bounded Workbench action owner validates the exact `handleIngest()` result
   against observed Graph evidence;
6. generic plugin completion is never described as reviewed-external graph
   execution;
7. malformed, contradictory, partial or uncertain outcomes persist as
   `execution_outcome_unknown` and are never retried automatically; and
8. `server.js` remains a thin orchestrator.

Permitted action outcomes are limited to:

```text
admission_allow_graph_write_observed
admission_allow_no_graph_write_observed
admission_review_no_graph_write_observed
admission_reject_no_graph_write_observed
execution_outcome_unknown
```

## Exact-base refresh

The authorization was compared with every intervening merge before advancing
its implementation base:

- PR #300 changed only `cli.js` and `lib/contradiction-rules.js` and merged as
  `9a9e7a545be806b395a38f0152c584fdb282b577`;
- PR #302 changed ADR documentation paths/redirects only and merged as
  `eb05e9ee0e7b2cf3bdecbf6d2fa404e71f386328`;
- PR #301 changed only
  `lib/workbench/memory-context-audit-source.js` and its existing test, passed
  Security Checks run `31040031226` and Benchmark Regression run
  `31040031538`, and merged as
  `725dbba334a786f051d5753764088e3b5338c54c`.

None changes `lib/ingest.js`, `server.js`, `package.json`, the authorized new
action-owner path or the authorized new test path. The B2B contract and file
scope therefore remain source-compatible; only the exact implementation base is
advanced.

## Current gate

Only this implementation gate is open:

```text
V4_B2B_INGEST_APPROVAL_AUTHORITY_REPAIR
```

The successor must start from exact canonical main
`725dbba334a786f051d5753764088e3b5338c54c` and may change exactly:

```text
lib/ingest.js
lib/workbench/ingest-approval-action.js
server.js
package.json
test/v4-b2b-ingest-approval-authority-gap.test.js
```

Required implementation constraints:

- `lib/ingest.js` binds canonical `default` workspace into the hashed snapshot
  and rejects non-default workspace before persistence;
- `lib/workbench/ingest-approval-action.js` owns exact snapshot validation,
  durable approval execution, truthful result/Graph evidence mapping,
  receipt/audit binding and fail-closed finalization;
- the new module remains at or below 300 physical lines;
- `server.js` only parses/authenticates/routes/wires and delegates, with net
  physical-line growth non-positive;
- `package.json` changes only the runtime `files` allowlist;
- the new real-server/SQLite test proves positive and adversarial behavior;
- the successor does not import or call
  `executeReviewedExternalGraphMutation()`;
- no Graph, Kernel, storage, approval-flow, plugin, schema or dependency change.

The implementation must emit exactly one verdict:

```text
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_BLOCKED_GAP
```

A blocked verdict is acceptable evidence. It must not be hidden by weakening
assertions or by labelling a plugin return as a committed mutation.

## Remaining execution order

1. Implement and falsify the exact five-file B2B repair.
2. Reconcile the result and close V4-B2 only if exact-head runtime, receipt,
   audit, package and smoke evidence is sufficient.
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
- Non-default workspace fails before approval persistence.
- Generic plugin completion is not a canonical action outcome.
- The reviewed external graph owner is used only with its complete validated
  input chain.
- New domain logic does not accumulate in `server.js`.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No production external-client route.
- No non-default or caller-selected HTTP workspace authority.
- No new API key, identity provider or tenant mapping.
- No new approval database, queue, status, schema, migration or dependency.
- No direct replacement of `handleIngest()` with
  `executeReviewedExternalGraphMutation()`.
- No automatic retry, repair or compensation.
- No Workbench UI, MCP, CLI, release or deployment change.
- No V4-complete or V5-complete claim.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
