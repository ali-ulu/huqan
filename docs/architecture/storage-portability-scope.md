# Storage-Portability Scope Note — #2115 Phase 2 (Memory owns this port)

**Status:** scope note only. No code, runtime, package version or release change.
**Owner:** Memory context (#2446). This note defines what the Memory storage port covers and what it explicitly does NOT cover, so #2446 Move cannot quietly include what #2115 excluded.
**Measured at:** `origin/main` @ `00cb5c37`, 2026-09-27. All paths/lines verified by reading source, not dir names.

## 1. Portable layout (derived, not configured per file)

`lib/memory-persistence-paths.js: derivePersistenceLayout(memoryPath, explicitDbPath)`:

- `dbPath` = explicitDbPath OR `memoryPath` with `.json` → `.db`
- `embeddingPath` = `memoryPath` → `.embeddings.json`
- `journalPath` = `memoryPath` → `.mutations.json`
- `assertDistinctPersistencePaths` throws on collision — each role gets a distinct path.

`resolveDbPath` roots: `[process.cwd(), os.tmpdir()]` + optional `opts.rootDir` + dirname of `opts.memoryPath`. `resolveContainedPath` canonicalizes through roots (symlink escape rejected). Same roots in root `storage.js: resolveDbPath`.

Backends: SQLite (`better-sqlite3`, optional via `lib/sqlite-availability.js`, WAL via `lib/sqlite-durability.js`, busy-retry via `lib/sqlite-busy-retry.js`), JSON (`lib/memory-store-json-persistence.js`, `lib/graph-json-persistence.js`), hermetic memory (no store injected). `lib/sqlite-persistence-validation.js: assertStoreOpenAllowed` gates opens.

## 2. What the Memory port OWNS (portable through it)

Opened/closed/migrated by Memory, transactional boundary `store.withTransaction` where present:

| Table | Defined in | Via |
|---|---|---|
| `memories` | `lib/memory-store-sqlite-writer.js:46` | `openMemoryDatabase`, `persistStoreWrite` |
| `memory_events` | `lib/memory-store-sqlite-writer.js:63` | same handle |
| `memory_links` | `lib/memory-store-sqlite-writer.js:76` | `persistLinkMemories` |
| supersede / tombstone / temporal rows | `lib/memory-supersede.js`, `lib/memory-tombstone.js`, `lib/memory-temporal.js` through `memory-store-sqlite-writer.js: persistSupersede/persistTombstone/persistPatchMetadata` | same Memory handle, `MemoryStore` class retains handle/collection ownership (`lib/memory-store.js` header) |

Temporal reads (`runTemporalQuery`), queries (`runQuery`), links (`readLinks*`) receive read-only contexts with no mutation/SQLite access — port direction is fixed.

## 3. What the Memory port explicitly DOES NOT own

Each has its own handle, schema, and migration path. Reaching into these from Memory (or vice versa) violates #2446 Rule 7.

| Store | Tables | Owner (per #2446) | Opened by | Evidence |
|---|---|---|---|---|
| Graph | `nodes, edges, audit_log, candidate_claims, mutation_journal, mutation_receipts` | Knowledge | `graph.js` via `lib/graph-sqlite-schema.js:15,28,53,66,82,88`, `graph-mutation-runtime.js: runMutationOnce{Sqlite,Json,JsonLocked}` | `graph.js` class Graph; callers `kernel.js:1`, `causalSimulator.js:1` |
| HuqanStorage | `checkpoints, goal_memory, agent_runs, tool_approvals` | AgentAction (agent loop leases/checkpointing) | root `storage.js` via `lib/storage/schema.js:19,33,48,65` (`applyStorageSchema`) | `storage.js:6`; diagnostic `lib/cli-doctor.js:142` |
| Experience journal | `experience_journal` | Trust (durable record) | injected `store.withTransaction`, fail-closed, SHA-256 integrity | `lib/experience/journal.js:15,67,173`; header contrasts vs `lib/observability/` best-effort |
| Observability | `observability_events, observability_runs, observability_alert_rules, observability_alerts, agent_queue_jobs` | Observability | injected `db` via `lib/observability/schema.js:12` + migrations, `createObservabilityService({db})` | `lib/observability/health.js:4`, `retention.js:30`; sole server-runtime caller `server.js` |
| `rustGraph.js` / `huqan-core` | none durable | Knowledge backend surface via port OR excluded in writing (#2446 Rule 5, still open) | child-process transport, holds `memoryPath` string + `_pending` map only | `rustGraph.js` 399L; callers `kernel.js:33`, `lib/reason-sandbox.js:29` |

## 4. No-ninth-surface alignment (#2372 / #2373)

#2373 maps eight existing record surfaces. This note creates none: Experience `experience_journal` durability, Observability best-effort telemetry, Trust receipts (`lib/receipt/`, no DB handle), and Memory/Knowledge/AgentAction tables above are all pre-existing surfaces. Trust ↔ Observability boundary must align with #2373, not duplicate it.

## 5. Port rules (binding for #2446 Enforce/Move)

1. Memory port = open/close/migrate/transaction for `memories, memory_events, memory_links` (+ supersede/tombstone/temporal through the same handle) only.
2. Graph, HuqanStorage, Experience, Observability each own their handles and migrations. No cross-store transactions.
3. No context reaches into another's storage, transaction, or in-memory state (#2446 Rule 7).
4. `rustGraph.js` holds no durable handle; its `memoryPath` string is a routing hint, not ownership.
5. If #2115 port scope excludes something, #2446 does not quietly include it (conflict check).
