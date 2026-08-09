# Current Operating Roadmap

**Live baseline:** `main` at
`75821f6` (PR #588 merge). This line is an observation, not a base pin — see the
authorization-artifact rule under the current gate.

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
exact-identifier authority boundary. V4-B2 action/approval evidence is closed:
the authorized authority repair is implemented and proved. V4-B3 receipt-export
user flow is now closed: the bounded, verified export route is implemented,
reachable and proved. V4-B5 final closeout remains open, and V4 completion
remains unclaimed.

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
- Benchmark Regression run `31181386707`: `SUCCESS`, including full `npm test`
  on Node 20 and Node 22 and the Docker build;
- Architecture Checks run `31181386832`: `SUCCESS`;
- zero unresolved review threads;
- merge/live main `e02eb03e79e10d6bc65e02322febe5eb2fd15055`.

Security-evidence limitation: PR #520's Security Checks run `31181386576`
executed the pre-#510 workflow, which tolerated `npm ci` and `npm audit`
failures and skipped scanning when no scanner was present. It is recorded as
lifecycle evidence only and is deliberately not claimed as hardened security
evidence. PR #510 merged as `30e7dc7` and replaced that workflow with fail-hard
gitleaks and Semgrep enforcement, so hardened attestation of the V4-B2 runtime
comes only from check runs on or after that merge.

Hardened attestation on record:

- Security Checks run `31186846627`: `SUCCESS`;
- workflow `.github/workflows/security.yml` at head
  `b6bfd7cce2d8ca0753e75b02ffa7ca5c6b368bce`, which is this reconciliation
  branch rebased onto `c6780ebe` and therefore contains #510's fail-hard
  `gitleaks-action@v2` and Semgrep steps;
- created `2026-08-07T14:17:34Z`.

That run attests the post-#510 tree containing the merged V4-B2 runtime. It is
the first hardened green on this branch; any later head on the same branch
carries its own run, and the closure claim rests on this recorded ID rather than
on whichever run happens to be latest.

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

## Closed V4-B3 evidence

The V4-B3 gate is closed. PR #588 implemented the authorized receipt export user
flow at exact head `5452a768` and emitted:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT
```

It merged as main `75821f6dd4fa2f0efb0fc8669acb9c733954e5c0`, and issue #271 is
closed. The closure record with full evidence and its two recorded reservations
is `docs/task-packs/v4-b3-receipt-export-closure-reconciliation.md`.

The gap the gate existed for is gone. `exportMaterializedReceiptBundle()` had a
sufficient source owner and zero production callers; the bundle is now reachable
from one authenticated, read-only Workbench route:

```text
GET /api/workbench/receipt-bundle
```

The five decided product decisions were built as recorded: single Workbench
route with no CLI/MCP/UI surface; canonical `default` workspace bound before any
read with exact string matching, so padded, cased, blank, numeric, boolean,
array, object and traversal forms fail closed with `400`; mandatory
`verifyExportedBundle()` before any body is written, with `409` and no bundle on
failure; no redaction, proved byte-identical against a direct seam export; and
both ceilings — `MAX_RECEIPTS = 1024`, `MAX_SERIALIZED_BUNDLE_BYTES = 2 MiB` —
enforced during the read with `413` and no partial bundle. `Cache-Control:
no-store` and `X-Content-Type-Options: nosniff` hold on `200`, `400`, `409` and
`413`.

The earlier `V4_B3_RECEIPT_EXPORT_USER_FLOW_BLOCKED_GAP` was cleared by building
its prerequisite rather than by relaxing the contract. V4-B3A (issue #554, PR
#562) supplied the bounded streaming source seam, and B3 consumes it by
`require()`; no limit parameter was added to the shared read index, no ceiling
was approximated from receipt count, and no ceiling was applied after
materialization.

Scope was seven files: the six the task-pack authorized plus
`lib/module-reachability.js`, added under the PR #585 source-backed amendment so
the three discharged B3A `NOT_YET_WIRED` acknowledgements could be removed once
the exporter made those modules reachable. Two docs-only stop conditions were
recorded before any code: the `package.json` exact-base reconciliation (PR #582)
and that scope amendment.

Two reservations are on record rather than smoothed over, and both are resolved.
The single local `npm test` failure was environmental —
`plugins/receipt-exporter.test.js` could not load `pdfkit`, which B3 neither uses
nor touches — confirmed by CI passing the same test with dependencies installed.
And the Node 20 leg of the full-suite matrix was still `in_progress` when the
merge landed at `23:58:28Z`; it reported SUCCESS at `00:04:29Z`, six minutes
later. The matrix is green on both versions, but the merge preceded its own
required evidence, which is recorded because a gate that merges before its
evidence reports is only accidentally correct.

## Current gate

Only this gate is open:

```text
V4_B5_SOURCE_TEST_CI_RELEASE_CLOSEOUT
```

Tracking issue: #272, `[V4-B5] V4 source/test/CI/release closeout`.

No authorization task-pack exists for it yet. The first step is therefore a
source-backed authorization pack, not implementation: it must fix the closeout
scope, the exact evidence that would justify a V4-complete claim, and the
falsification conditions that would deny one. Opening runtime work, widening
scope, adding a dependency or claiming V4 completion before that pack merges is
a stop condition.

The base rule that V4-B3 arrived at carries forward: bind an immutable
authorization artifact rather than a pre-merge `main` SHA, open the
implementation branch from live `origin/main` at the moment work starts, require
the artifact in ancestry, and re-prove source compatibility over the authorized
files by parsing both revisions every time — never by trusting a recorded
verdict. V4-B3 needed three reconciliations before it could start; that cost is
what the rule exists to avoid repeating.

## Remaining execution order

1. Authorize V4-B5 with a source-backed closeout task-pack before any
   implementation: fix the closeout scope, the exact evidence that would justify
   a V4-complete claim, and the falsification conditions that would deny one.
2. Complete V4-B5 source/test/CI/package/release closeout against that pack.
3. Reconcile the result and close V4 only if exact-head source, test, CI,
   package and release evidence is sufficient.
4. Begin V5 only after V4 closeout and external interoperability entry gates.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- A task-pack binds an immutable authorization artifact SHA, never a pre-merge
  `main` tip. Implementation branches open from live `origin/main`, must carry
  that artifact in ancestry, and prove the authorized file scope unchanged since
  it. Pinning a branch tip stales itself the moment the authorization merges and
  turns every unrelated merge into a reconciliation.
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
