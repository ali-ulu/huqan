'use strict';

// Run: node --expose-gc benchmarks/bench-memory-store-open.js
// #3208: opening a SQLite-backed MemoryStore. Before, every row was parsed
// and kept in a Map for the store's lifetime; now open validates every row
// (corruption is still reported at open) but retains none. Reports open time,
// the heap still held once open returns, and one contentKind page read (the
// error-prevention preflight shape).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');

function seed(dbPath, rows) {
  const store = new MemoryStore({ useSQLite: true, dbPath });
  const insert = store._db.prepare(`INSERT INTO memories (workspace_id, memory_id, kind, content_json,
    content_hash, status, metadata_json, provenance_json, trust_policy_version, created_at)
    VALUES (?, ?, 'memory-record', ?, ?, 'active', '{}', ?, '1.0.0', ?)`);
  const provenance = JSON.stringify({ provenanceId: 'p', sourceRef: 'bench', sourceTitle: 'bench',
    sourceType: 'memory-api', actor: 'bench', timestamp: '2026-01-01T00:00:00.000Z',
    workspaceId: 'bench', trustPolicyVersion: '1.0.0', confidence: 1 });
  store._db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const content = { kind: i % 100 === 0 ? 'rule' : 'note', text: `memory ${i} `.repeat(8) };
      insert.run('bench', i.toString(16).padStart(12, '0'), JSON.stringify(content), `h${i}`, provenance,
        new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
    }
  })();
  store.close();
}

const WARM_CALLS = 20;

function heapMb() {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

for (const rows of [10000, 50000, 100000]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-open-'));
  const dbPath = path.join(dir, 'memory.db');
  seed(dbPath, rows);
  const before = heapMb();
  const start = process.hrtime.bigint();
  const store = new MemoryStore({ useSQLite: true, dbPath });
  const openMs = Number(process.hrtime.bigint() - start) / 1e6;
  const retainedMb = heapMb() - before;
  const readStart = process.hrtime.bigint();
  const rules = store.list({ workspaceId: 'bench', contentKind: 'rule' });
  const coldKindListMs = Number(process.hrtime.bigint() - readStart) / 1e6;
  // Preflight lists the same rules on every gated action: the warm mean is
  // the steady state, the cold call the first action after open.
  const warmStart = process.hrtime.bigint();
  for (let i = 0; i < WARM_CALLS; i++) store.list({ workspaceId: 'bench', contentKind: 'rule' });
  const warmKindListMs = Number(process.hrtime.bigint() - warmStart) / 1e6 / WARM_CALLS;
  console.log(JSON.stringify({ rows, openMs: Number(openMs.toFixed(1)), retainedHeapMb: Number(retainedMb.toFixed(1)),
    coldKindListMs: Number(coldKindListMs.toFixed(2)), warmKindListMs: Number(warmKindListMs.toFixed(2)),
    rules: rules.total, gc: typeof global.gc === 'function' }));
  store.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
}
