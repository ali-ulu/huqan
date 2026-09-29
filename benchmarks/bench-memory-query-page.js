'use strict';

// Run: node benchmarks/bench-memory-query-page.js
// Measures a 100-row page at 10k and 50k records. The baseline calls the
// original in-memory query engine with the same validated records; the indexed
// path calls MemoryStore.query. Output is measurements, not a CI threshold.
// Local Windows / Node 22 sample (2026-09-29):
// 10k: 31.519 -> 3.429 ms (9.19x); 50k: 413.732 -> 17.143 ms (24.13x).
// The fixture seeds rows directly, so these numbers cover read latency only;
// opening/warming the SQLite store and write throughput are excluded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');
const { runQuery } = require('../lib/memory-query-engine');

function measure(fn) {
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3));
}

function run(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-query-bench-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
  try {
    const insert = store._db.prepare(`INSERT INTO memories
      (workspace_id, memory_id, kind, content_json, content_hash, status,
       metadata_json, provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'memory-record', ?, '', 'active', '{}', '{}', '1.0.0', ?)`);
    store._db.transaction(() => {
      for (let i = 0; i < size; i++) {
        const id = String(i).padStart(8, '0');
        const createdAt = `2026-01-01T00:${String(Math.floor(i / 60000)).padStart(2, '0')}:${String(Math.floor(i / 1000) % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
        const record = { memoryId: id, workspaceId: 'bench', kind: 'memory-record',
          content: `item-${id}`, status: 'active', createdAt, metadata: {}, provenance: {} };
        insert.run('bench', id, JSON.stringify(record.content), createdAt);
        store._memories.set(store.makeMemoryKey('bench', id), record);
      }
    })();
    const opts = { workspaceId: 'bench', limit: 100, offset: 100 };
    const baseline = measure(() => runQuery({ memories: store._memories,
      isActiveRecord: store._isActiveRecord.bind(store) }, opts));
    const sqlite = measure(() => store.query(opts));
    console.log(JSON.stringify({ records: size, baselineMs: baseline, sqliteMs: sqlite,
      speedup: Number((baseline / sqlite).toFixed(2)) }));
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
}

run(10000);
run(50000);
