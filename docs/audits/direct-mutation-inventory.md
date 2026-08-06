# Direct Mutation Inventory

## Plan Check

- Task: `TB-A3`
- Repository: `ali-ulu/huqan`
- Source base: `main @ 694c5485768720cc14b5f53978b08f27c3dfb9c5`
- Mode: source inventory only
- Runtime changes: none

This inventory records production, conditional-production, operator, and
library-only mutation paths that write Graph, approval, agent-memory, plugin,
or persistence state. A direct call is not automatically a defect. It is a
bypass when it avoids the admission, mutation-journal, facade, audit, or
receipt boundary that would otherwise own the same intent.

## Classification

| value | meaning |
| --- | --- |
| `canonical` | The write uses its current intended admission or journal owner. |
| `conditional-journal` | The same entry can be journaled or legacy unjournaled according to input/backend. |
| `direct-bypass` | The write avoids a relevant admission, journal, or facade boundary. |
| `direct-owner` | Direct persistence is the current source owner; no stronger boundary is claimed. |
| `library-only` | Exported and tested, but no non-test in-repository caller was proven. |
| `operator-only` | Explicit script or manual utility, not an application transport. |

## Production and Conditional-Production Mutation Matrix

| caller surface | source write | target / owner | classification | audit, receipt, and failure evidence |
| --- | --- | --- | --- | --- |
| Kernel candidate acceptance, reachable through exported `Kernel.ingestCandidateClaim()` | `lib/conflict-detector.js` `acceptCandidateClaimJournaled()` calls `Graph.addCandidateClaim()`, `addNode()` twice, and `addEdge()` inside `Graph.runMutationOnce()` | Candidate review route / Graph | `canonical`, gap 1 closed | **Gap 1 closed (#217).** When a real `Kernel` is passed (the `Kernel.ingestCandidateClaim()` route always does), an "accept"-recommended candidate is now evaluated through the same `_evaluateLearnAdmission()` gate `_commitBackgroundEdge`/`proposeEdge` use (`approvalRequired: false`, so risk-based auto-review can still hold a candidate) before anything is written. On `allow`, the node/edge writes and the `CLAIM_ACCEPTED` audit happen inside one `Graph.runMutationOnce()` call with a committed canonical receipt (reusing the exact receipt-building `kernel.js` `learn()` uses, no new receipt logic). On `review`/`reject`, nothing is written canonically -- the candidate is recorded `pending` and the decision itself is audited. Callers that pass a bare `Graph` (not a `Kernel`) still get the prior direct-write behavior unchanged, since admission evaluation requires a `Kernel`. |
| Public compatibility method | `kernel.js:931-935` calls `Graph.addCandidateClaim()` | Kernel API / Graph candidate store | `library-only` and direct if externally invoked | No admission, mutation journal, audit, or receipt in the method. No non-test in-repository caller was resolved. |
| Kernel learn | `kernel.js` `learn()` delegates to the learn use case; `lib/learn-use-case.js` calls `Graph.addNode()`, `addEdge()`, `addTag()`, and `save()` | Kernel learn / Graph | `canonical`, gap 4 closed | **Gap 4 closed (#216).** Every `learn()` call now goes through `Graph.runMutationOnce()`, not just calls that pass an explicit `mutationOperationId` -- one is generated internally when the caller doesn't supply one. A canonical receipt is attached when the call produced an admission receipt; bypass-mode/no-admission learns commit and journal without one (`buildCanonicalReceipt` returning `null` is now a supported "no receipt for this mutation" signal, not an error, on both backends). Learn admission remains the parent boundary; a `strictProvenance` rejection re-appends its `REJECT` audit event after the mutation-journal rollback restores it, so the rejection itself still survives on the audit trail even though nothing was journaled as completed. |
| Kernel derived cross-link | `kernel.js:1093-1149` calls `Graph.addEdge()` | Kernel learn helper / Graph | `conditional-journal` through the parent learn | It runs only with `parentAdmissionAllowed: true`, is explicitly not a background admission bypass, and is inside the parent `runMutationOnce()` callback when `mutationOperationId` is supplied. It appends a `derived_edge` audit but has no per-edge receipt. |
| Kernel proposal paths used by production plugins | `kernel.js:334-432` and `675-755` call Graph only after admission | Kernel / Graph | `canonical` | Non-allow results are audited. Allowed proposals write and return admission evidence. `repo-memory` and `company-brain` use these proposal methods rather than direct Graph writes. |
| Kernel maintenance | `kernel.js:1836-1840` and `1850-1897` delegate optimize, consolidation, and save operations | Kernel maintenance facade / Graph | `direct-owner` | Maintenance mutations are not learn admission events and have no mutation journal or receipt. Save failures in consolidation are logged and swallowed after in-memory mutation. |
| HTTP ingest queue creation | `server.js:1261-1292` calls `AxiomStorage.saveToolApprovalIfAbsent()` | HTTP approval runtime / approval DB | `direct-owner` | Snapshot hash and idempotency key protect queue creation. There is no audit or receipt at enqueue; persistence failure returns HTTP 503. |
| HTTP ingest approval decision | `server.js:1164-1256` leases/finalizes approval, invokes `handleIngest()`, then calls direct audit helper | Approval store, plugin capability, Graph audit | `direct-bypass` across the combined outcome boundary | Approval receipt is finalized before best-effort `Graph.appendAuditEvent()`. Audit failure is caught; receipt, plugin mutation, and audit are not atomic. `state_transition_not_asserted` is explicitly reported. |
| HTTP ingest audit helper | `server.js:83-97` calls `cli.kernel.graph.appendAuditEvent()` | HTTP runtime / Graph audit store | `direct-bypass` of Kernel audit facade | Callers catch failures and continue with the already-finalized approval result. The returned audit ref is not a committed mutation receipt. |
| HTTP startup | `new CLI()` constructs Kernel, whose constructor calls `graph.load()` at `kernel.js:181`; `server.js:39` then calls `cli.kernel.graph.load()` explicitly | HTTP bootstrap / Graph persistence | constructor-owned load followed by a `direct-bypass` of `Kernel.reload()` facade | The HTTP path performs two startup load attempts unless constructor options disable the first. Neither load has an audit or receipt; load behavior may fall back between persistence backends. |
| MCP approval enqueue | `mcpServer.js:560-599` calls `AxiomStorage.saveToolApproval()` | MCP runtime / approval DB | `direct-owner` | No enqueue receipt or Graph audit. Unavailable storage returns `persisted: false`. |
| MCP approved learn | `mcpServer.js:901-1057` resolves approval and calls `Kernel.learn()` | MCP approval runtime, Kernel, Graph | `conditional-journal`, gap 3 closed | **Gap 3 closed (#216).** The JSON Graph backend now has its own durable mutation journal (`graph.js` `_runMutationOnceJson`, a sibling `*.mutations.json` file written atomically) with the same idempotent-replay, rollback-on-error, and hash-chained-receipt guarantees as SQLite (`test/durable-mutation-journal.test.js` proves parity across both backends). `mcpServer.js` no longer gates `mutationOperationId` binding on the backend name (`getStats().backend === 'sqlite'`); presence of `runMutationOnce` is now a genuine capability signal on both backends. Still open: learn failure resolution and approval finalization are unchanged by this fix; gap 4 (legacy learn without `mutationOperationId`, unjournaled) is separate and remains open. |
| LLM memory plugin | `plugins/llm-memory-plugin.js:12-21` calls `learnFromLLM()` and then `kernel.graph.save()` | Plugin hook / Kernel learn plus Graph persistence | `direct-bypass` of `Kernel.persist()` for save | Learn uses Kernel behavior; the extra direct save has no persistence audit or receipt, and hook rejection is swallowed by the caller path. |
| Shield auto-learn | `lib/shield.js:89-119` calls `learnFromLLM()` and direct `graph.save()` | SDK/server shield / Kernel learn plus Graph persistence | `direct-bypass` of `Kernel.persist()` for save | Learn errors are shaped. A save exception can escape; no save audit or receipt exists. |
| CLI save, backup, and restore | `cli.js:553-600` and `707-715` call Kernel persistence and backup helpers | CLI / Kernel or filesystem persistence | `direct-owner` | Interactive gating/audit is pre-execution and best-effort; a direct `execute()` caller can skip the interactive mutation gate. Restore creates a safety backup but no durable mutation receipt. |
| Backup/restore helper | `backupRestore.js` `createBackup()`/`restoreBackup()` copy/replace persistence files and remove WAL/SHM files | Filesystem persistence helper | `direct-owner`, gap closed | **Gap 7 closed.** `createBackup()` stages files in a temp directory and atomically `fs.renameSync`s it to the final backup name — a failed copy never leaves a partial backup visible under its final name. `restoreBackup()` replaces each live file atomically (temp file + rename) and stops immediately on the first failure (no partial writes, no automatic retry). Both paths now return/throw a durable operation `receipt` (`operationId`, `status: 'complete'\|'partial'\|'failed'`, timestamps, and — on failure — the exact restored/skipped file list plus `safetyBackupDir` for manual recovery). Still not a Graph-mutation-journal receipt (this is filesystem-level, not `Kernel.runMutationOnce()`); the CLI-level interactive gating gap in the row above is unchanged. |
| Graph save/load | `graph.js:1215-1467` writes or replaces JSON, SQLite, embeddings, nodes, edges, tags, and audit state | Graph persistence owner | `direct-owner` | Regular save/load is separate from `runMutationOnce()` and has no save/load receipt. SQLite load can fall back to JSON; JSON load failure logs and returns. |
| Agent working memory | `agent.js:177-186` writes `agent.memory.json` | Agent / process-local working-memory file | `direct-owner` | Best-effort write errors are swallowed. This is not `MemoryStore` or canonical Graph state and has no audit or receipt. |
| AgentV3 checkpoints and run memory | `agent.v3.js:185-203`, `334-346` call `AxiomStorage` checkpoint/run/goal methods | AgentV3 / SQLite agent store | `direct-owner` | Storage methods own their transactions. They are not Graph mutation journal receipts. |

## Connector and Plugin Conclusions

- Production `plugins/repo-memory.js` and `plugins/company-brain.js` propose
  nodes and edges through Kernel admission. No direct Graph content write was
  found in those plugins.
- Production GitHub repository ingest therefore does not itself bypass Graph
  admission. Its missing identity/workspace/Route Receipt coverage is tracked
  separately by `TB-A2`.
- `lib/github-connector.js:253-424` directly persists candidate claims and can
  reach accepted candidate Graph writes through `lib/conflict-detector.js`.
  The module is `library-only` because no non-test in-repository caller was
  proven; it must not be called production-reachable from tests alone.
- `adapters/markdown-adapter.js:137-156` calls `Kernel.learn()` per section but
  has no proven non-test caller. The production `repo-memory` adapter path is a
  different boundary.

## Memory Mutation Inventory

No non-test production caller of the independent `MemoryStore` mutation API
was found. `Kernel` constructs the store and closes it through the Graph close
hook. `MemoryStore.save()` / `load()` are status/no-op compatibility methods,
not an observed canonical memory-write path.

The following similarly named state is separate:

- `agent.js` JSON working memory;
- `AgentV3` checkpoint, run, and goal records in `AxiomStorage`;
- Graph nodes/edges/tags and Graph persistence;
- HTTP/MCP approval records.

They must not be merged into one generic "memory mutation" claim.

## Operator, Demo, Test, and Archived Separation

| surface | classification | evidence |
| --- | --- | --- |
| `scripts/seed-demo.js` | `operator-only` demo seed | Direct `kernel.graph.addNode()`, `addEdge()`, and `save()`. |
| `egitim.js` | `operator-only` training utility | Learns through Kernel and then directly saves Graph. |
| `demo-causal-autolearn.js` | demo-only | Constructs and mutates an isolated Graph directly. |
| `test/**` and `*.test.js` | test-only | Test fixtures and spies are not production callers. |
| `benchmarks/**` | benchmark-only | Benchmark mutation is not production reachability. |
| `docs/archive/**` | archived | Historical code excerpts are not canonical source. |

## Open Ownership and Durability Gaps

1. ~~Accepted candidate claims can create canonical nodes/edges without Kernel
   proposal admission or a durable mutation journal.~~ **Closed (#217).** See
   the table row above.
2. HTTP approval receipt finalization, plugin mutation, and audit append do not
   share one atomic outcome boundary.
3. ~~MCP approved learn has backend-dependent journal strength: SQLite receives
   a mutation operation id while JSON does not provide the same crash-safe
   guarantee.~~ **Closed (#216).** JSON now has its own durable mutation
   journal with the same guarantees as SQLite; see the table row above.
4. ~~Kernel legacy learn without `mutationOperationId` remains unjournaled.~~
   **Closed (#216).** Every `learn()` call now journals, with an
   internally-generated operationId when the caller doesn't supply one; see
   the table row above.
5. Derived cross-links inherit the parent decision and conditional parent
   journal, but have no per-edge receipt.
6. Plugin/shield direct Graph saves bypass the Kernel persistence facade and
   have no persistence audit/receipt.
7. Backup/restore changes multiple persistence artifacts without a transaction
   or durable operation receipt.
8. Direct public/library compatibility methods can bypass stronger boundaries
   if external consumers invoke them; in-repository production reachability is
   unproven.

## Validation Ownership

Existing focused owners include:

- `kernel.test.js`
- `graph.test.js`
- `lib/conflict-detector.test.js`
- `lib/github-connector.test.js`
- `plugins/repo-memory.test.js`
- `test/approval-flow.test.js`
- `test/approval-queue.test.js`
- `test/mcp-server-gate-enforcement.test.js`
- `server.test.js`
- `cli.test.js`
- `backupRestore.test.js`

The complete regression suite remains required for closeout. A focused pass is
not full-regression evidence.

## Non-Claims

This inventory does not claim:

- that every direct call is a defect or must be removed;
- that any mutation path was changed, journaled, or made transactional;
- that audit is equivalent to a mutation receipt;
- that local approval receipts are V5 Route Receipts;
- that library-only exports are dead or safe to remove;
- that Graph, MemoryStore, agent memory, and approval storage are one state
  system;
- that the listed durability gaps are fixed;
- V5 ecosystem readiness or completion.
