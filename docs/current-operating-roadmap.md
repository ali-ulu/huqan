# Current Operating Roadmap

**Live baseline:** `main` at
`725dbba334a786f051d5753764088e3b5338c54c` (PR #301 WB2 exact-identifier
repair merge).

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
exact-identifier authority boundary. V4-B2 action/approval evidence is open.
V4-B3 receipt-export user flow and V4-B5 final closeout remain open.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#264 | WB2 source, adapter, route and server evidence | V4-B1 closed; no action/approval |
| #265-#267 | B2 existing-runtime characterization | Existing lifecycle bounded but insufficient |
| #297-#299 | B2B authority-gap authorization and reconciliation | Exact five-file successor only |
| #301 | WB2 exact-identifier repair | No B2 action-path change |

## Closed V4-B1 evidence

PR #249 proved `V4_WB2_RUNTIME_SOURCE_SUFFICIENT` using real Kernel, SQLite
Graph and close/reopen evidence.

Verified exact-head evidence:

- PR #249 head `59942569d327249d9319e9228f79be17feeb80ae`:
  Security Checks `31022648513`, Benchmark Regression `31022647907`, full
  `npm test` job `92363082880`, all `SUCCESS`;
- PR #254 head `d662f6e545e5be12d5f7937d45599f1f6c33c989`:
  Security Checks `31025724234`, Benchmark Regression `31025724138`, full
  `npm test` job `92373576698`, all `SUCCESS`;
- PR #262 head `fb77b175cf3a44d05ca0cc13b9f172c9ea1d241b`:
  Security Checks `31031154969`, Benchmark Regression `31031154766`, full
  `npm test` job `92391978739`, all `SUCCESS`.

PR #254 implemented the internal audit adapter, PR #258 the pure route contract,
PR #262 the bounded authenticated server route and real SQLite/HTTP smoke, and
PR #264 the V4-B1 reconciliation.

A later source audit found that the adapter normalized caller identity with
`String(...).trim()` even though its authorization required exact, non-coerced
`recordId` and `workspaceId` values. PR #301 repaired that boundary:

- head `2c02879f8076e07678c4a5f0610f3a329e382900`;
- exactly the adapter and its test owner;
- padded and non-string identities fail before any audit-owner read;
- Security Checks `31040031226`: `SUCCESS`;
- Benchmark Regression `31040031538`: `SUCCESS`;
- full `npm test` job `92421841117`: `SUCCESS`;
- zero unresolved review threads;
- merge/live main `725dbba334a786f051d5753764088e3b5338c54c`.

No server, route, Graph, Kernel, storage, package or B2 action-path behavior was
changed by PR #301.

## V4-B2A observed source contract

Current source owns durable SQLite `tool_approvals` state, claim/finalization
CAS, execution leases, expired-lease recovery, reviewed/blocked receipts,
approval audit emission and these HTTP routes:

```text
POST /api/ingest
GET /api/ingest/approvals
POST /api/ingest/approvals/:approvalId
```

PR #267 used real `server.js`, Kernel, SQLite Graph, AxiomStorage and loopback
HTTP and produced the controlling verdict:

```text
V4_B2_EXISTING_RUNTIME_CONTRACT_BLOCKED_GAP
```

Proven gaps:

1. queued manual/decision snapshots do not durably bind caller workspace;
2. approval calls generic `handleIngest()` and records
   `state_transition_not_asserted`, not a bounded final action outcome;
3. the current snapshot is not the complete reviewed-external graph chain, so
   substituting `executeReviewedExternalGraphMutation()` would manufacture
   authority.

## Authorized V4-B2B product contract

PR #298 added:

```text
docs/task-packs/v4-b2b-ingest-approval-authority-gap-authorization.md
```

The shared API-key surface is bounded to canonical workspace `default`.
Non-default workspace fails before persistence. Manual and decision ingest are
the only action kinds. A bounded Workbench owner must validate the immutable
snapshot, exact `handleIngest()` result and observed Graph evidence. Unknown,
malformed or contradictory outcomes persist as `execution_outcome_unknown` and
are never retried automatically. `server.js` remains a thin orchestrator.

Permitted outcomes are exactly:

```text
admission_allow_graph_write_observed
admission_allow_no_graph_write_observed
admission_review_no_graph_write_observed
admission_reject_no_graph_write_observed
execution_outcome_unknown
```

## Exact-base refresh

Exact compare
`f765ddd687e06823c45dba5d498ec6543234eed8..725dbba334a786f051d5753764088e3b5338c54c`
is ten commits ahead and zero behind. The intervening changes affect mutable
execution docs, `cli.js`, `lib/contradiction-rules.js`, ADR relocation and the
WB2 adapter/test repair. They affect none of the five authorized V4-B2B
implementation files.

The product decision, scope and acceptance contract remain unchanged. The
controlling task-pack records the refreshed implementation base.

## Current gate

Only this gate is open:

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

Required constraints:

- canonical `default` workspace is hashed into the immutable snapshot;
- non-default workspace fails before persistence;
- the bounded action owner derives truthful outcomes from exact result and
  observed Graph evidence;
- unknown outcomes fail closed without retry;
- the new module stays at or below 300 physical lines;
- `server.js` net physical-line growth is non-positive;
- package metadata changes only the runtime `files` allowlist;
- no Graph, Kernel, storage, approval-flow, plugin, schema or dependency change;
- no call to `executeReviewedExternalGraphMutation()`.

The implementation must emit exactly one verdict:

```text
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_SUFFICIENT
V4_B2_INGEST_APPROVAL_AUTHORITY_REPAIR_BLOCKED_GAP
```

## Remaining execution order

1. Implement and falsify the exact five-file B2B repair.
2. Reconcile and close V4-B2 only with sufficient exact-head evidence.
3. Complete V4-B3 receipt inspection/export through a real user flow.
4. Complete V4-B5 source/test/CI/package/release closeout.
5. Begin V5 only after V4 closeout and external interoperability entry gates.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- No Graph mutation before exact valid approval.
- Missing, rejected, expired and unknown outcomes fail closed.
- Decision bytes do not replace workspace, snapshot or receipt meaning.
- Generic plugin completion is not a canonical action outcome.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No production external-client route.
- No non-default or caller-selected HTTP workspace authority.
- No new approval database, queue, status, schema, migration or dependency.
- No automatic retry, repair or compensation.
- No Workbench UI, MCP, CLI, release or deployment change.
- No V4-complete or V5-complete claim.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified.
