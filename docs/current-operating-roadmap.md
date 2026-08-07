# Current Operating Roadmap

**Live baseline:** `main` at
`e02eb03e79e10d6bc65e02322febe5eb2fd15055` (PR #520 V4-B2B implementation merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The External Client Enablement-0 evidence program is closed, but its HTTP
adapter remains production-unreachable. V4 Workbench runtime-evidence work is
active.

V4-B1 read-only inspector runtime evidence is closed, including the repaired
exact-identifier authority boundary. V4-B2 action/approval evidence is now
closed: the authorized authority repair is implemented and proved. V4-B3
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
| #300, #302, #301, #303 | Unrelated issue fixes and ADR cleanup | No authorized V4-B2B implementation file changed |

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

A later source audit found that the internal adapter normalized caller identity
with `String(...).trim()` even though its authorization required exact,
non-coerced `recordId` and `workspaceId` values. PR #301 repaired that boundary:

- exact reviewed head `2c02879f8076e07678c4a5f0610f3a329e382900`;
- exactly `lib/workbench/memory-context-audit-source.js` and
  `test/v4-wb2-memory-context-audit-source.test.js`;
- padded and non-string identities fail before any audit-owner read;
- Security Checks run `31040031226`: `SUCCESS`;
- Benchmark Regression run `31040031538`: `SUCCESS`;
- full `npm test` job `92421841117`: `SUCCESS`;
- zero unresolved review threads;
- merge/live main `725dbba334a786f051d5753764088e3b5338c54c`.

No server, route, Graph, Kernel, storage, package or B2 action-path behavior was
changed by PR #301.

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
  Security Checks run `31040031226`, Benchmark Regression run `31040031538`
  and full `npm test` job `92421841117`; it rejects padded and non-string
  identities before any audit-owner read and merged as
  `725dbba334a786f051d5753764088e3b5338c54c`;
- PR #303 changed only `kernel.js`, `lib/learn-use-case.js` and
  `test/derived-edge-receipt.test.js`, closed issue #214, and merged as
  `7304ed8622b706ffc662892948fb097dcebbaee8`.

None changes `lib/ingest.js`, `server.js`, `package.json`, the authorized new
action-owner path or the authorized new test path. The B2B contract and file
scope therefore remain source-compatible; only the exact implementation base is
advanced.

## Source-reality scope amendment

The existing `test/v4-b2a-ingest-approval-runtime-contract.test.js` still asserts the pre-repair gap: non-default caller
workspace values queue successfully and the persisted snapshot omits
`workspaceId`. The authorized repair requires non-default values to fail before
persistence and canonical `default` to be hashed into the snapshot. Both cannot
remain passing contracts.

The implementation scope is therefore amended from five to six files. The old
B2A characterization test may change only where its superseded gap assertions
conflict; its queue, idempotency, rejection, lease, unknown-state and zero-
mutation-before-approval coverage remains binding.

## Closed V4-B2 evidence

PR #520 implemented the authorized B2B repair and emitted:

```text
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT
```

Controlling exact-head evidence:

- head `99847901411128b1a0515ed5da23589206716f06`;
- Security Checks run `31181386576`: `SUCCESS`;
- Benchmark Regression run `31181386707`: `SUCCESS`, including full `npm test`
  on Node 20 and Node 22 and the Docker build;
- Architecture Checks run `31181386832`: `SUCCESS`;
- zero unresolved review threads;
- merge/live main `e02eb03e79e10d6bc65e02322febe5eb2fd15055`.

Both proved gaps are repaired:

1. `lib/ingest.js` binds canonical `default` into the hashed snapshot. Absence
   means `default`; a supplied value must be the exact string `default`. Values
   are not trimmed or coerced first, so padded and non-string identities fail
   closed before persistence, matching the PR #301 boundary. The binding hash
   now covers workspace, kind, source ref, idempotency and payload, so editing a
   persisted snapshot's workspace no longer verifies.
2. `lib/workbench/ingest-approval-action.js` (274 lines) owns snapshot
   validation, the durable claim, execution, outcome derivation, receipt/audit
   binding and fail-closed finalization. The outcome comes from the admission
   summary and the observed Graph delta, with observed evidence authoritative.
   `server.js` shrank from 1466 to 1399 physical lines.

Exact-base note: the authorization pinned `6a16a40`, which live `main` had
passed by 176 commits. Re-verification before implementation found `lib/ingest.js`,
the B2A test and `lib/workbench/` unchanged since that base; `package.json` moved
only inside its `files` allowlist; `server.js` changed only through route-auth
centralization, and the ingest routes are already declared in
`lib/http/route-auth-policy.js`. The contract stayed source-compatible, so only
the base advanced.

Scope amendment: the authorization named six files. `server.test.js` was added
as a seventh under a source-backed amendment, because two of its assertions
pinned the exact superseded `plugin_execution_returned` /
`state_transition_not_asserted` labels. Only those two changed; its
receipt-kind, snapshot-hash, result-ref and idempotent-replay coverage is
unchanged.

## Current gate

Only this authorization gate is open:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_AUTHORIZATION
```

Source-backed finding that opens it: `exportMaterializedReceiptBundle()`
(`lib/receipt/receipt-read-index.js:212`) already builds a materialized receipt
chain and returns a bundle that `verifyExportedBundle()` can validate, but its
only caller in the tree is `test/v4-receipt-materialization-read-index.test.js`.
Production callers number zero.

The user-reachable receipt surface today is read-only:

- `GET /api/trust-receipt` and `GET /api/trust-receipt/:receiptId`;
- `GET /api/workbench/trust-receipt/:receiptId` (V4-B1, closed);
- `plugins/receipt-exporter.js`, which writes single receipts to files on
  `afterLearn` rather than emitting a chain-validated bundle.

This is the same shape V4-B1 resolved for WB2: a sufficient source owner with no
route. V4-B3 therefore needs an authorization task-pack before code, deciding at
minimum the export surface and method, the bounded workspace authority, whether
export is verified before it is returned, the redaction policy for a bundle that
may leave the local trust boundary, and the response size ceiling.

A successor must not widen the read surface, add a dependency or claim V4
closure while writing that task-pack.

## Remaining execution order

1. Authorize V4-B3 through a source-backed task-pack.
2. Implement and falsify the authorized V4-B3 receipt export user flow.
3. Reconcile the result and close V4-B3 only if exact-head runtime, receipt,
   package and smoke evidence is sufficient.
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
