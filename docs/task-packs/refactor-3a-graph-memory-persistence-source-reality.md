# REFACTOR-3A - Graph, Memory, and Persistence Source Reality

## Gate

- Repository: `ali-ulu/huqan`
- Canonical base: `main @ 63ecc4b54e13eb3c058dfa1704f7d6ed625ebaa7`
- Previous checkpoint: `REFACTOR-2F_CLOSEOUT_AUDIT_GREEN`
- Mode: source-reality and decomposition planning only

This gate identifies existing owners before any Graph, MemoryStore, or
persistence change. It does not authorize implementation.

## Reuse-First Decision

Do not add a generic repository, storage adapter, Graph facade, Memory facade,
snapshot abstraction, dependency, or framework.

Reuse the existing owners and migrate only callers whose behavior can be
preserved by an existing method. Introduce a new seam only when a separately
reviewed source gap proves that no current method can preserve the contract.

## Current Owners

| Concern | Current owner | Source behavior |
| --- | --- | --- |
| Graph state and algorithms | `graph.js` | Nodes, edges, candidates, audit events, traversal, maintenance |
| Graph persistence | `graph.js` | SQLite mirror, JSON snapshot, embedding sidecar, load/save/close |
| Memory domain store | `lib/memory-store.js` | Memories, events, links, lifecycle, SQLite transactions and retry |
| Kernel composition | `kernel.js` | Constructs Graph and MemoryStore and coordinates their close lifecycle |
| Safe path resolution | `persistencePaths.js` and `lib/memory-store-utils.js` | Existing contained-path rules |
| Backup and restore | `backupRestore.js` | Graph JSON/DB/WAL/SHM, embeddings, and agent-memory files |
| Agent checkpoints and approvals | `storage.js` | Separate AxiomStorage domain; not Graph or MemoryStore persistence |

These stores represent different domains. Similar use of SQLite does not make
them interchangeable.

## Persistence Reality

Graph:

- may open SQLite unless explicitly disabled;
- keeps in-memory Graph collections as the runtime state;
- `save()` writes the SQLite representation when enabled and also writes the
  JSON snapshot and embedding sidecar;
- `load()` prefers populated SQLite state, otherwise reads JSON and may migrate
  that state into SQLite;
- exposes synchronous `load()`, `save()`, `optimize()`, and `close()` behavior.

MemoryStore:

- opens SQLite only when explicitly enabled;
- otherwise remains an in-memory memory/event/link store;
- owns bounded SQLite retry, transaction, rollback, tombstone, and supersede
  behavior;
- intentionally returns no-op lifecycle results from `save()` and `load()`;
- does not own the Graph JSON snapshot or embedding sidecar.

The Kernel persistence descriptor and CLI backup selection currently derive the
Graph DB path from `memoryPath`. An independently supplied Kernel `dbPath` is
not a CLI backup-selection contract. Changing that is the separate
`PERSISTENCE-PATH-ALIGNMENT` behavior decision and is forbidden here.

## Existing Graph Read Semantics

`Graph.getNodes()`, `getNode()`, `getEdges()`, and `getInEdges()` return
defensive records. `getNode()` is not a pure read: it updates `lastAccessed`
and, with SQLite enabled, persists that touch. Direct collection access may
therefore observe or mutate different state. It is unsafe to replace internal
access mechanically with getters without caller-specific contract evidence.

`getCandidateClaims()` has different reference behavior and must not be
silently upgraded to a defensive-copy contract in this program.

## Direct Internal Callers

Active runtime callers include:

- `kernel.js`: node count reads, `selfLearn()` edge-count reads, and mutable
  consolidation over `_edges`;
- `kernel.v2.js`: temporal edge reads;
- `dream.js`: whole-node scans and embedding mutation;
- `causalSimulator.js`: node existence and label reads;
- `lib/provenance-query.js`: whole Graph and candidate query reads;
- `server.js`: Graph view reads;
- company-brain, contradiction-alert, devil-advocate, discovery-engine, and
  idea-mri plugins: read-only fact/entity inputs.

Operational/demo callers include `demo-causal-autolearn.js`, `egitim.js`, and
`scripts/seed-demo.js`.

No production caller outside `MemoryStore` directly accesses its private
memory, event, or link collections.

## Existing Contract Evidence

- `graph.test.js` owns Graph CRUD, defensive-copy, workspace, lifecycle,
  persistence, and maintenance behavior;
- `graph.causal.test.js` owns causal and backend loading behavior;
- `test/kernel-persistence-roundtrip.test.js` owns Kernel Graph auto-load and
  auto-save round trips;
- `test/graph-metadata-persistence.test.js` owns JSON/SQLite metadata parity;
- `lib/audit-log.test.js` owns audit persistence and ordering;
- `test/memory-store-sqlite.test.js` owns MemoryStore SQLite persistence,
  workspace, WAL, and rollback behavior;
- `test/memory-store-concurrency.test.js` and
  `test/memory-store-lock-timeout.test.js` own bounded contention behavior;
- `test/memory-package-roundtrip.test.js` owns memory package, tombstone, and
  supersede semantics;
- `cli.test.js` owns the current backup/restore path derivation;
- `test/cli-graph-source-boundary.test.js` owns the completed CLI boundary.

Existing tests are reused. A new test file is allowed only when a later
caller-specific migration exposes an untested observable contract.

## Minimal Successor Sequence

1. `REFACTOR-3A1_GRAPH_PERSISTENCE_CONTRACT_AUDIT`
   - run and inspect the existing Graph lifecycle/persistence contracts;
   - add no test if current evidence is sufficient;
   - document a precise gap before any new assertion.
2. `REFACTOR-3B_GRAPH_INTERNAL_CALLER_RECONCILIATION`
   - split mutable Dream/Kernel paths from read-only KernelV2,
     causal-simulator, provenance/server, and plugin paths;
   - do not migrate causal-simulator reads to `getNode()` because its
     last-access and SQLite-touch effects are absent from the current caller;
   - do not design one broad collection API for all callers.
3. `REFACTOR-3C_MEMORY_AND_PERSISTENCE_OWNERSHIP_CLOSEOUT`
   - confirm MemoryStore and existing persistence helpers already have bounded
     ownership;
   - implement only a source-proven gap.

Every successor requires an exact-base scope, independent review, CI, merge,
and closeout. A no-op/YAGNI closeout is preferred over an empty abstraction.

## Forbidden Scope

- public Kernel, KernelV2, Graph, or MemoryStore API changes;
- new repository, adapter, facade, snapshot, or storage abstraction;
- Graph or MemoryStore schema/file-format changes;
- SQLite pragma, migration, transaction, retry, or rollback changes;
- JSON/SQLite precedence or sidecar changes;
- path derivation or backup file-set changes;
- workspace, audit, tombstone, supersede, or error semantics changes;
- package, dependency, CLI, MCP, server, V5, Policy Auditor, or product work.

## Stop Conditions

Stop and rescope if:

- a caller relies on mutable collection identity that an existing getter does
  not preserve;
- an existing getter adds last-access, persistence, or other observable side
  effects absent from the direct access being replaced;
- a proposed change can lose Graph, MemoryStore, or AxiomStorage data;
- independent `dbPath` support is required;
- backend selection, load precedence, migration, or backup ownership changes;
- a new public API, schema, dependency, version, verdict, receipt, or envelope
  decision is required;
- one change needs both Graph and MemoryStore implementation files.

## Acceptance

- this document is the only changed file;
- current owner and caller claims match canonical source;
- existing Graph, persistence, MemoryStore, CLI boundary, and full suites have
  zero failures;
- Security Checks, Benchmark Regression, and Docker build pass;
- independent review confirms that the successor order is reuse-first and
  behavior-preserving.

## Non-Claims

- Graph, MemoryStore, or persistence was not decomposed in this gate;
- no direct internal caller was migrated;
- no storage backend was unified;
- no data migration or compatibility guarantee was added;
- REFACTOR-3 is not complete;
- REFACTOR-4 and Policy Auditor have not started;
- the refactor program is not complete.
