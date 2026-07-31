# Durable Mutation Journal Ownership Closure

## Plan Check

- Task: `TB-A4`
- Repository: `ali-ulu/huqan`
- Source base: `main @ 4546d94a3a584a50d26c75548befc5ff42e66670`
- Previous checkpoint: `TB-A3_CLOSEOUT_GREEN`
- Decision: `DEFER_PLUGIN_JOURNAL_MIGRATION`
- Mode: source-reality and ownership closure only
- Runtime changes: none

This audit reconciles the durable mutation-journal decision with current
production source and executable tests. It assigns an owner to every known
production mutation class without promoting admission, audit, approval
idempotency, or ordinary persistence into a durable journal claim.

`huqan_current` returned no grounded answer for journal ownership. The source,
tests, and exact merged history below are therefore the controlling evidence.

## Durable Journal Owner

The only current canonical Graph mutation journal is the SQLite-backed
`Graph.runMutationOnce()` boundary.

| layer | source owner | bounded guarantee |
| --- | --- | --- |
| schema and transaction | `graph.js:352-367`, `571-627` | Requires a non-empty operation ID and SQLite. The callback, completed journal row, and optional canonical receipt-chain row share one SQLite transaction. |
| rollback | `graph.js:616-627` | A failed callback rolls back SQLite and restores mutable in-memory nodes, edges, candidates, audits, and indexes. |
| replay | `graph.js:581-595` | A completed operation returns the stored result and receipt without re-running the callback, including after restart. |
| Kernel integration | `kernel.js:861-924` | Only a caller-supplied non-empty `mutationOperationId` enters the journal. Ordinary legacy learn remains unjournaled. |
| canonical runtime binder | `mcpServer.js:963-1004` | An approved MCP learn binds its stable approval ID only when the active Graph backend is SQLite. |
| forwarded library input | `lib/provenance-ingest.js` | A caller operation ID is forwarded; the ingest helper does not generate replay identity. |

Method presence is not a durability capability. JSON Graph exposes
`runMutationOnce()` but refuses before executing the callback with
`DURABLE_MUTATION_JOURNAL_UNAVAILABLE`. The MCP backend-name check is current
source reality, not a portable capability contract.

## Journal and Non-Journal Mutation Matrix

| production path | current owner | journal status | replay / failure boundary |
| --- | --- | --- | --- |
| approved MCP learn on SQLite | approval ID -> `Kernel.learn()` -> `Graph.runMutationOnce()` | `journaled` | Same approval decision is idempotent and the Graph mutation replays from the stored result/receipt. |
| approved MCP learn on JSON | MCP approval state and ordinary Kernel learn | `not journaled` | The transport deliberately does not bind an operation ID. Approval state can persist, but there is no crash-safe Graph journal. |
| ordinary Kernel learn | caller and Kernel learn use case | `not journaled` unless the caller supplies an operation ID | Backward-compatible behavior has no automatic replay identity. |
| provenance ingest learn | external caller | `conditional` | Durable only for a supplied ID on SQLite; no ID is invented. |
| Company Brain manual/decision ingest | plugin batch of admission-gated Kernel proposals | `not journaled as a batch` | Each proposal has admission evidence, but the multi-proposal operation has no atomic rollback, stable batch replay ID, or composite receipt. |
| Repo Memory GitHub/Markdown ingest | plugin batch of admission-gated Kernel proposals | `not journaled as a batch` | HTTP approval idempotency does not become a plugin mutation operation ID. Mid-batch failure can leave partial accepted work. |
| LLM Memory `afterAsk` | admission-aware learn followed by direct Graph save | `not journaled` | The asynchronous chain is not awaited and rejects are suppressed; no operation replay or persistence receipt exists. |
| Shield auto-learn | Shield/SDK learn followed by direct Graph save | `not journaled` | Learn failure is shaped, but save/retry is not a journaled operation. |
| accepted candidate claim | conflict-detector / Graph candidate and domain writes | `not journaled` | Writes and later audit do not share a rollback/replay/receipt boundary. Production transport reachability remains unproven in-repository. |
| HTTP ingest approval lifecycle | snapshot-derived approval key, lease, and approval store | `approval-idempotent, not Graph-journaled` | Duplicate queue records and expired leases are handled at approval level. The receipt explicitly reports `state_transition_not_asserted`. |
| Graph save/load, maintenance, backup/restore | Graph or filesystem persistence owner | `not journaled` | These operations have their own error behavior, but no mutation operation receipt or universal rollback transaction. |
| agent JSON / AgentV3 state | agent or AxiomStorage owner | `separate state` | These stores are not the canonical Graph mutation journal. |

## Cross-Store Failure Boundary

The approved MCP path does not make Graph and approval storage one atomic
transaction:

1. AxiomStorage claims the approval.
2. `Kernel.learn()` may commit the Graph journal and canonical receipt.
3. AxiomStorage then finalizes the approval status.

A crash or finalization error between steps 2 and 3 can leave committed Graph
state and an unresolved `executing` approval. Current source returns
`APPROVAL_FINALIZATION_FAILED` or a manual-reconciliation result and does not
claim retry safety. Adding restart recovery here requires an explicit approval
state-machine and reconciliation policy; it is not a documentation cleanup.

The HTTP path has a lease/recovery model for its approval record, but its
plugin mutation, approval receipt, and best-effort Graph audit likewise do not
share an atomic transaction.

## Executable Evidence

| proof | executable owner | demonstrated behavior |
| --- | --- | --- |
| journal once/replay/restart | `test/durable-mutation-journal.test.js` | Callback executes once; restart replay returns stored result. |
| failure rollback | `test/durable-mutation-journal.test.js` | Failed callback leaves no node or audit and permits a later first execution. |
| receipt chain | `test/durable-mutation-journal.test.js` | One canonical hash-chained receipt is stored per journaled operation and replay returns it. |
| JSON fail-closed | `test/durable-mutation-journal.test.js`, `test/graph-durability-capability-contract.test.js` | JSON refuses before callback; method presence alone proves nothing. |
| MCP restart and replay | `test/mcp-dogfood-client.test.js` | Pending approval survives restart; approved SQLite learn persists; repeated approval does not re-execute. |
| MCP claim/failure state | `test/faz2-mcp-shared-state-approval-persistence.test.js` | Competing approval claims are blocked and thrown execution becomes failed/manual reconciliation. |
| HTTP lease failure | `test/ingest-approval-recovery.test.js` | Lease expiry becomes visible failure and is not automatically re-executed. |
| HTTP receipt limit | `server.test.js` | Approved receipt does not assert transactional Graph state persistence. |
| plugin proposal isolation | `test/faz2-plugin-write-isolation.test.js` | Company Brain and Repo Memory use proposal seams; review/reject does not create canonical writes. |
| Repo Memory non-journal contract | `plugins/repo-memory.test.js` | Proposal receipt data is forwarded without inventing connector operation IDs. |

The skipped `test/faz2-universal-mutation-boundary.contract.test.js` wording
that calls Company Brain and Repo Memory raw direct Graph writers is historical
and contradicts current proposal-based source. It is not closure evidence.

## Ownership Decisions

1. SQLite `Graph.runMutationOnce()` owns the existing durable Graph journal.
2. The approved MCP caller owns the stable operation ID on its integrated path.
3. Legacy learn and proposal APIs remain backward compatible and do not invent
   replay identities.
4. Approval-store idempotency, Graph audit, admission receipts, and file save
   are distinct mechanisms and remain distinct claims.
5. Company Brain and Repo Memory own admission-aware proposal batches, not
   atomic journaled batches.
6. LLM Memory and Shield own their direct save behavior; it is explicitly
   outside the durable journal.
7. Unknown cross-store outcomes require manual reconciliation; automatic retry
   is forbidden by the current source contract.

No owner remains ambiguous. Paths without journal ownership are classified as
deliberate legacy/non-journal behavior or as a future product decision, not
silently treated as durable.

## Decision

`DEFER_PLUGIN_JOURNAL_MIGRATION`

Do not retrofit every plugin, connector, candidate, maintenance, or
persistence mutation into `Graph.runMutationOnce()` in TB-A4.

A future migration requires a concrete retry-safe product path and explicit
decisions for:

- the public entry point and stable external operation-ID owner;
- the complete atomic mutation unit;
- one canonical receipt/result shape and workspace-chain policy;
- partial admission, review, reject, and mid-batch failure semantics;
- SQLite-only fail-closed behavior or a separately approved backend contract;
- approval/Graph cross-store crash reconciliation;
- compatibility for callers that do not supply an operation ID.

Generating a random ID inside a plugin would not protect client retries.
Journalizing each proposal separately would retain partial-batch risk. Making
operation IDs mandatory for existing callers would be a public behavior
change. None is authorized here.

## Non-Claims

This closure does not claim:

- universal durable, atomic, or exactly-once mutation behavior;
- atomicity between Graph and approval storage;
- that admission or audit is transaction commit evidence;
- that JSON Graph supports durable journaling;
- that HTTP approval idempotency makes plugin mutation replay-safe;
- that direct-save paths were migrated or fixed;
- that automatic recovery from an unknown execution outcome is safe;
- V5 ecosystem readiness or completion.
