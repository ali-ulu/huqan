'use strict';

// Run: node benchmarks/bench-memory-store-startup.js
// Measures MemoryStore open time and heap delta at 10k, 50k, and 100k records.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');

function seedDatabase(dbPath, size) {
  const store = new MemoryStore({ useSQLite: true, dbPath, eagerWarmup: false });
  try {
    const insert = store._db.prepare(`INSERT INTO memories
      (workspace_id, memory_id, kind, content_json, content_hash, status,
       metadata_json, provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'memory-record', ?, '', 'active', '{}', '{}', '1.0.0', ?)`);
    const insertEvent = store._db.prepare(`INSERT INTO memory_events
      (workspace_id, event_id, event_type, memory_id, actor, details_json,
       provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'STORE', ?, 'bench', '{}', '{}', '1.0.0', ?)`);
    const insertLink = store._db.prepare(`INSERT INTO memory_links
      (workspace_id, link_id, relation, from_memory_id, to_memory_id, confidence,
       provenance_json, trust_policy_version, created_at)
      VALUES (?, ?, 'related_to', ?, ?, 1.0, '{}', '1.0.0', ?)`);

    store._db.transaction(() => {
      for (let i = 0; i < size; i++) {
        const id = String(i).padStart(8, '0');
        const createdAt = `2026-01-01T00:${String(Math.floor(i / 60000)).padStart(2, '0')}:${String(Math.floor(i / 1000) % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
        insert.run('bench', id, JSON.stringify(`item-${id}`), createdAt);
        insertEvent.run('bench', `evt-${id}`, id, createdAt);
        if (i > 0) {
          const prevId = String(i - 1).padStart(8, '0');
          insertLink.run('bench', `link-${id}`, prevId, id, createdAt);
        }
      }
    })();
  } finally {
    store.close();
  }
}

function measureOpen(dbPath, eager) {
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  const store = new MemoryStore({ useSQLite: true, dbPath, eagerWarmup: eager });
  const openTimeMs = Number(process.hrtime.bigint() - start) / 1e6;
  const heapDeltaMb = Number(((process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)).toFixed(2));
  store.close();
  return { openTimeMs: Number(openTimeMs.toFixed(3)), heapDeltaMb };
}

function runBenchmark(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-startup-bench-'));
  const dbPath = path.join(dir, 'memory.db');
  try {
    seedDatabase(dbPath, size);
    const lazy = measureOpen(dbPath, false);
    const eager = measureOpen(dbPath, true);
    console.log(JSON.stringify({
      records: size,
      lazyOpenMs: lazy.openTimeMs,
      lazyHeapMb: lazy.heapDeltaMb,
      eagerOpenMs: eager.openTimeMs,
      eagerHeapMb: eager.heapDeltaMb,
      speedup: Number((eager.openTimeMs / lazy.openTimeMs).toFixed(1)),
      memorySavingsMb: Number((eager.heapDeltaMb - lazy.heapDeltaMb).toFixed(2)),
    }));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('--- MemoryStore Startup Performance Benchmark: Lazy vs Eager ---');
runBenchmark(10000);
runBenchmark(50000);
runBenchmark(100000);
