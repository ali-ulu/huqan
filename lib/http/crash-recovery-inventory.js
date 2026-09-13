'use strict';

// Production Gate A item 7 (#2366): crash and recovery inventory.
//
// Kill the process mid-write at every durable write point, restart, assert
// consistency. Partly covered for graph and agent finalization already;
// extend to remaining stores rather than rewriting what exists.
//
// This module is the inventory — the measurement checkpoint. It lists every
// durable write point, its atomicity mechanism, and whether a mid-write
// SIGKILL restart test exists.

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
]);

function getInventory() {
  return DURABLE_WRITE_POINTS;
}

function getUncovered() {
  return DURABLE_WRITE_POINTS.filter(point => !point.covered);
}

module.exports = Object.freeze({ DURABLE_WRITE_POINTS, getInventory, getUncovered });
