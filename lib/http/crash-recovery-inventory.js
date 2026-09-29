'use strict';

// Production Gate A item 7 (#2366), extended by Gate B #2125.
//
// This inventory tracks durable product state whose loss, duplication or
// corruption can change trust, replay, authorization, recovery or canonical
// state. Derived exports/caches are out of scope; RESUMABLE checkpoints that
// explicitly allow losing the latest tail are covered by their declared
// durability-class tests rather than being mislabeled as evidence stores.
//
// Each row names the atomicity mechanism and the executable recovery evidence.
// "covered" means the named test proves restart/rollback/fail-closed semantics,
// not merely that a source file contains a write call.

const DURABLE_WRITE_POINTS = Object.freeze([
  {
    id: 'graph.json',
    path: 'memory.json / memory.embeddings.json / journal',
    files: ['memory.json', 'memory.embeddings.json', 'memory.journal.json'],
    mechanism: 'journal prepare -> fsync -> rename -> fsync dir (atomicWriteFileSync + graph-json-snapshot)',
    crashTest: 'test/graph.test.js + test/graph-json-snapshot.test.js + test/process-crash.test.js [json] SIGKILL at before-prepared/after-prepared/after-graph-publish',
    covered: true,
  },
  {
    id: 'graph.sqlite',
    path: 'memory.db (+ -wal/-shm)',
    files: ['memory.db'],
    mechanism: 'SQLite WAL + better-sqlite3 transaction + prepare/commit, pragma journal_mode=WAL, busy_timeout',
    crashTest: 'test/process-crash.test.js [sqlite] + test/graph.test.js sqlite-transaction-crash',
    covered: true,
  },
  {
    id: 'agent-run-finalization',
    path: 'agent_runs / tool_approvals (SQLite)',
    files: ['memory.db:agent_runs, tool_approvals'],
    mechanism: 'claim lease + finalize with recovery sweep recoverExpired/StuckLeaseless',
    crashTest: 'test/agent-finalization-crash.test.js, test/ingest-recovery.test.js',
    covered: true,
  },
  {
    id: 'streaming-trust.evaluations',
    path: 'streaming-trust/evaluations/{deliveryId}.json',
    files: ['streaming-trust/evaluations/*.json'],
    mechanism: 'fs.open wx 0o600 + write + fsync + close, fsync dir, EEXIST duplicate check',
    crashTest: 'test/gateA-crash-recovery.test.js [streaming-trust] SIGKILL before/after-fsync',
    covered: true,
  },
  {
    id: 'streaming-trust.writeback',
    path: 'streaming-trust/writeback-started|complete/{deliveryId}.json',
    files: ['streaming-trust/writeback-started/*.json', 'streaming-trust/writeback-complete/*.json'],
    mechanism: 'same exclusive write + fsync dir, reserve then commit, idempotent retry',
    crashTest: 'test/gateA-crash-recovery.test.js [streaming-trust writeback]',
    covered: true,
  },
  {
    id: 'github-app-beta.store',
    path: 'github-app-beta/*.json + fsync dir',
    files: ['github-app-beta/*.json'],
    mechanism: 'atomicWriteFileSync + fsync dir',
    crashTest: 'test/v5-c7-github-app-beta-store.test.js (fsync verified)',
    covered: true,
  },
  {
    id: 'backup.create',
    path: 'backups/.staging-{id} -> backups/{id}/manifest.json + rename',
    files: ['backups/{id}/*, manifest.json'],
    mechanism: 'staging dir + fs.copy + write manifest + rename (atomic), prune stale staging on crash',
    crashTest: 'backupRestore.js staging rename is atomic; crash leaves no partial under final name',
    covered: true,
  },
  {
    id: 'backup.restore',
    path: '.restore-progress.json + atomicReplaceFile (tmp- + rename)',
    files: ['.restore-progress.json', '{memory.db,memory.json,...}.tmp-* -> rename'],
    mechanism: 'progress journal + per-file tmp+rename atomic; safety backup pre-created',
    crashTest: 'backupRestore.test.js interrupted restore requires safety backup before retry',
    covered: true,
  },
  {
    id: 'external-action-receipt',
    path: 'external-action-receipt.jsonl (append) + shipped cursor',
    files: ['external-action-receipt.jsonl', 'external-action-receipt.jsonl.shipped.json'],
    mechanism: 'append-only JSONL + cursor count, ship cursor only advances on ack; seal JSONL append not transactional but idempotent by batchId/contentHash',
    crashTest: 'test/external-action-receipt-shipper.test.js (cursor resync on truncation)',
    covered: true,
  },
  {
    id: 'observability.jobs',
    path: 'observability jobs store (SQLite)',
    files: ['memory.db:observability jobs'],
    mechanism: 'enqueue + lease expiry sweep, recoverExpiredJobs bounded',
    crashTest: 'test/observability-recovery.test.js expired crash lease reclaimed',
    covered: true,
  },
  {
    id: 'memory-store.sqlite',
    path: 'memory-store SQLite event/state tables',
    files: ['memory-store.db'],
    mechanism: 'SQLite WAL + synchronous FULL for memory_events evidence; fail-closed corrupt-store startup',
    crashTest: 'test/sqlite-durability-contract.test.js + test/memory-store-sqlite.test.js + test/faults/corrupt-db.test.js',
    covered: true,
  },
  {
    id: 'external-client-replay.sqlite',
    path: 'external-client replay reservation SQLite store',
    files: ['external-client-replay.db'],
    mechanism: 'SQLite WAL + synchronous FULL + immediate transaction + bounded busy retry',
    crashTest: 'lib/external-client-replay-store.test.js committed reservation survives restart + forced insert rollback + cross-process single winner',
    covered: true,
  },
  {
    id: 'a2a.replay-task',
    path: 'A2A replay reservations + task completion records',
    files: ['*.reserved', '*.reserved-task', '*.completed'],
    mechanism: 'exclusive create (wx) + fsync; reservation precedes effect; completion is a separate write-once file',
    crashTest: 'test/a2a-task-lifecycle.test.js restart preserves replay refusal and completed task; reservation without completion remains unknown',
    covered: true,
  },
  {
    id: 'a2a.delegation-audit',
    path: 'A2A delegation audit rows',
    files: ['*.delegation'],
    mechanism: 'one file per event, exclusive create (wx) + write + fsync; unreadable rows counted instead of discarded',
    crashTest: 'test/a2a-delegation-audit.test.js audit rows survive log restart and unreadable rows remain visible',
    covered: true,
  },
  {
    id: 'mcp-capability-nonces',
    path: 'durable consumed MCP operator capability nonces',
    files: ['.huqan-capability-nonces/*.nonce'],
    mechanism: 'exclusive durable nonce file, shared directory across workers, fail-closed on unavailable store',
    crashTest: 'test/mcp-capability-nonce-durability.test.js consumed nonce stays consumed after restart + concurrent worker single winner',
    covered: true,
  },
  {
    id: 'registry.records',
    path: 'A2A/agent registry records',
    files: ['registry/*.json'],
    mechanism: 'durable record files keyed by domain-separated id; read validates stored identity and live trust root',
    crashTest: 'test/registry-route.test.js stored record survives boundary restart and revoked trust root is enforced on reread',
    covered: true,
  },
  {
    id: 'agent-memory.json',
    path: 'agent.memory.json',
    files: ['agent.memory.json'],
    mechanism: 'temporary file + atomic rename; failed rename preserves previous memory; corrupt file is quarantined and refused',
    crashTest: 'agent.test.js + test/agent-memory-persistence.test.js atomic rename failure preserves old state and persisted runs resume after restart',
    covered: true,
  },
  {
    id: 'command-policy',
    path: 'external action command policy file',
    files: ['policy.json', 'policy.json.editor-lock'],
    mechanism: 'exclusive cross-process editor lock + temp file + rename + optimistic revision check',
    crashTest: 'test/command-policy-editor.test.js stale/busy writes fail closed and a fresh editor reads the committed revision',
    covered: true,
  },
  {
    id: 'hypothesis-thresholds',
    path: 'per-workspace hypothesis threshold store',
    files: ['*.hypothesis-thresholds.json'],
    mechanism: 'temporary file + rename; malformed/out-of-range store fails closed instead of resetting',
    crashTest: 'test/hypothesis-thresholds.test.js persisted threshold rereads and malformed stores are refused',
    covered: true,
  },
  {
    id: 'emergency-stop',
    path: 'emergency stop record + tamper-evident ledger + receipts',
    files: ['*.stop.json', 'emergency-stop-ledger.jsonl', 'receipts.jsonl'],
    mechanism: 'exclusive stop record + hash-chained append ledger; integrity mismatch forces stopped state',
    crashTest: 'test/emergency-stop.test.js stop survives ledger restart; tamper/unreadable state fails closed',
    covered: true,
  },
]);

function getInventory() {
  return DURABLE_WRITE_POINTS;
}

function getUncovered() {
  return DURABLE_WRITE_POINTS.filter(point => !point.covered);
}

module.exports = Object.freeze({ DURABLE_WRITE_POINTS, getUncovered });
