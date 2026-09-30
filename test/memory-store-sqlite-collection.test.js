'use strict';

// #3208 slice 1: a SQLite-backed MemoryStore keeps memories in SQLite with a
// bounded cache instead of mirroring every row in a Map. Every read must stay
// byte-identical to what the full mirror produced on main; the golden digests
// in test/fixtures/memory-read-golden.json were recorded there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');
const { getContentHash } = require('../lib/memory-store-utils');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'memory-read-golden.json');

// A deterministic package and a battery of every MemoryStore read.

const WORKSPACE = 'ws-battery';
const OTHER_WORKSPACE = 'ws:other';

function provenance(index, workspaceId) {
  return {
    provenanceId: `prov-${index}`,
    sourceRef: index % 3 === 0 ? 'source-a' : 'source-b',
    sourceTitle: 'Battery Source',
    sourceType: index % 2 === 0 ? 'memory-api' : 'import',
    actor: index % 4 === 0 ? 'alice' : 'bob',
    timestamp: '2026-01-01T00:00:00.000Z',
    workspaceId,
    trustPolicyVersion: '1.0.0',
    confidence: 1,
  };
}

function memoryId(index) {
  // Mostly lowercase hex (the SQL page path); a few ids force the JS fallback.
  if (index === 7) return 'Upper-Case-Id';
  if (index === 11) return 'id:with:colon';
  return (0x1000 + index).toString(16).padStart(8, '0');
}

function content(index) {
  if (index % 5 === 0) return { kind: 'rule', text: `rule alpha ${index}` };
  if (index % 5 === 1) return { kind: 'note', text: `note beta ${index}` };
  if (index % 5 === 2) return `plain alpha beta ${index}`;
  if (index % 5 === 3) return { kind: 7, text: `numeric kind ${index}` };
  return { text: `gamma ${index}`, nested: { depth: index } };
}

function createdAt(index) {
  // Pairs share a timestamp so the id tie-break is exercised.
  const minute = String(Math.floor(index / 2)).padStart(2, '0');
  return `2026-02-01T10:${minute}:00.000Z`;
}

function buildMemories(workspaceId, count) {
  const memories = [];
  for (let index = 0; index < count; index++) {
    const status = index % 6 === 4 ? 'deleted' : 'active';
    memories.push({
      memoryId: memoryId(index),
      workspaceId,
      content: content(index),
      createdAt: createdAt(index),
      updatedAt: index % 3 === 0 ? `2026-03-01T00:${String(index).padStart(2, '0')}:00.000Z` : undefined,
      deletedAt: status === 'deleted' ? '2026-04-01T00:00:00.000Z' : undefined,
      status,
      metadata: { tag: index % 2 === 0 ? 'even' : 'odd', rank: index },
      provenance: provenance(index, workspaceId),
      trustPolicyVersion: '1.0.0',
    });
  }
  return memories;
}

function buildPackage(workspaceId, count) {
  return {
    version: '1.0.0',
    schemaVersion: '1.0.0',
    workspaceId,
    memories: buildMemories(workspaceId, count),
    events: [],
    links: [],
  };
}

function seedStore(store) {
  for (const [workspaceId, count] of [[WORKSPACE, 40], [OTHER_WORKSPACE, 6]]) {
    const result = store.importPackage(buildPackage(workspaceId, count), { targetWorkspaceId: workspaceId });
    if (!result.ok) throw new Error(`battery import failed: ${JSON.stringify(result.error)}`);
  }
}

function runBattery(store) {
  const ws = { workspaceId: WORKSPACE };
  const out = {};
  const record = (name, fn) => {
    try {
      out[name] = fn();
    } catch (error) {
      out[name] = { threw: error.message };
    }
  };
  record('load.count', () => store.load().count);
  record('list.default', () => store.list(ws));
  record('list.page', () => store.list({ ...ws, limit: 5, offset: 3 }));
  record('list.tombstoned', () => store.list({ ...ws, includeTombstoned: true }));
  record('list.kind.rule', () => store.list({ ...ws, contentKind: 'rule' }));
  record('list.kind.rule.page', () => store.list({ ...ws, contentKind: 'rule', limit: 2, offset: 1 }));
  record('list.kind.rule.tombstoned', () => store.list({ ...ws, contentKind: 'rule', includeTombstoned: true }));
  record('list.kind.missing', () => store.list({ ...ws, contentKind: 'nope' }));
  record('list.kind.numeric', () => store.list({ ...ws, contentKind: '7' }));
  record('list.other', () => store.list({ workspaceId: OTHER_WORKSPACE }));
  for (const index of [0, 4, 7, 11, 39]) {
    record(`get.${index}`, () => store.get(memoryId(index), ws));
  }
  record('get.missing', () => store.get('ffffffff', ws));
  record('get.wrongWorkspace', () => store.get(memoryId(1), { workspaceId: OTHER_WORKSPACE }));
  record('query.default', () => store.query(ws));
  record('query.page', () => store.query({ ...ws, limit: 4, offset: 2 }));
  record('query.updatedDesc', () => store.query({ ...ws, orderBy: 'updatedAt', order: 'desc', limit: 6 }));
  record('query.deleted', () => store.query({ ...ws, status: 'deleted' }));
  record('query.text', () => store.query({ ...ws, text: 'alpha' }));
  record('query.recall', () => store.query({ ...ws, text: 'alpha', recall: true }));
  record('query.kind', () => store.query({ ...ws, kind: 'memory-record' }));
  record('query.metadata', () => store.query({ ...ws, metadata: { tag: 'even' } }));
  record('query.actor', () => store.query({ ...ws, actor: 'alice' }));
  record('query.sourceRef', () => store.query({ ...ws, sourceRef: 'source-a' }));
  record('query.created', () => store.query({ ...ws, createdAfter: '2026-02-01T10:05:00.000Z',
    createdBefore: '2026-02-01T10:12:00.000Z' }));
  record('findByContentHash', () => store.findByContentHash(getContentHash(content(0)), ws));
  record('findBySourceRef', () => store.findBySourceRef('source-a', ws));
  record('findByKind', () => store.findByKind('memory-record', ws));
  record('findByStatus', () => store.findByStatus('deleted', ws));
  record('since', () => store.since('2026-02-01T10:15:00.000Z', ws));
  record('before', () => store.before('2026-02-01T10:03:00.000Z', ws));
  record('between', () => store.between('2026-02-01T10:04:00.000Z', '2026-02-01T10:08:00.000Z', ws));
  record('memoriesBetween', () => store.memoriesBetween('2026-02-01T10:04:00.000Z', '2026-02-01T10:08:00.000Z', ws));
  record('exportPackage', () => {
    const result = store.exportPackage(ws);
    // exportedAt is wall-clock; everything else is deterministic.
    if (result.package) delete result.package.exportedAt;
    return result;
  });
  return JSON.parse(JSON.stringify(out));
}

function withDb(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stores = [];
  const open = (opts = {}) => {
    const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db'), ...opts });
    stores.push(store);
    return store;
  };
  try {
    return fn(open);
  } finally {
    for (const store of stores) store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
}

function digests(results) {
  const out = {};
  for (const [name, value] of Object.entries(results)) {
    out[name] = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  return out;
}

function assertGolden(results, label) {
  const actual = digests(results);
  if (process.env.UPDATE_MEMORY_READ_GOLDEN === '1') {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ ...golden, digests: actual }, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')).digests;
  const drifted = Object.keys(expected).filter((name) => expected[name] !== actual[name]);
  assert.deepEqual(drifted, [], `${label}: reads drifted from the main mirror`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
}

test('every read matches the full-mirror golden, live and after reopening with a tiny cache', () => {
  withDb('huqan-3208-golden-', (open) => {
    const writer = open();
    seedStore(writer);
    assertGolden(runBattery(writer), 'live store');
    writer.close();
    assertGolden(runBattery(open({ memoryCacheSize: 3 })), 'reopened, cache 3');
    assertGolden(runBattery(open({ memoryCacheSize: 1 })), 'reopened, cache 1');
  });
});

test('opening a SQLite store keeps no memory records resident', () => {
  withDb('huqan-3208-open-', (open) => {
    seedStore(open());
    const store = open({ memoryCacheSize: 8 });
    assert.equal(store._memories instanceof Map, false, 'the SQLite backend is not a full Map mirror');
    assert.equal(store._memories.cachedCount(), 0);
    assert.equal(store._memories.size, 46, 'size still counts every valid row');
  });
});

test('reads never hold more records than the cache capacity', () => {
  withDb('huqan-3208-bound-', (open) => {
    seedStore(open());
    const store = open({ memoryCacheSize: 4 });
    runBattery(store);
    for (let index = 0; index < 40; index++) store.get(memoryId(index), { workspaceId: WORKSPACE });
    assert.ok(store._memories.cachedCount() <= 4, `cached ${store._memories.cachedCount()}`);
  });
});

test('a contentKind list is answered by SQL, not by scanning every record', () => {
  withDb('huqan-3208-kind-', (open) => {
    seedStore(open());
    const store = open();
    // Generated ids are lowercase hex; the battery's main workspace carries
    // non-hex ids on purpose, which keep the JS order (golden test above).
    store._memories.values = () => { throw new Error('full scan'); };
    const result = store.list({ workspaceId: OTHER_WORKSPACE, contentKind: 'rule' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.memories.map((m) => m.memoryId), [memoryId(0), memoryId(5)]);
  });
});

test('writes stay visible after their record is evicted from the cache', () => {
  withDb('huqan-3208-evict-', (open) => {
    const store = open({ memoryCacheSize: 2 });
    const first = store.store({ content: 'first', workspaceId: WORKSPACE }).memory;
    assert.equal(store.patchMetadata(first.memoryId, { tag: 'patched' }, { workspaceId: WORKSPACE }).ok, true);
    for (let index = 0; index < 5; index++) store.store({ content: `filler ${index}`, workspaceId: WORKSPACE });
    assert.equal(store.get(first.memoryId, { workspaceId: WORKSPACE }).memory.metadata.tag, 'patched');
    assert.equal(store.tombstone(first.memoryId, { workspaceId: WORKSPACE }).ok, true);
    for (let index = 5; index < 10; index++) store.store({ content: `filler ${index}`, workspaceId: WORKSPACE });
    assert.equal(store.findById(first.memoryId, { workspaceId: WORKSPACE }).ok, false);
    assert.equal(store.get(first.memoryId, { workspaceId: WORKSPACE }).memory.status, 'deleted');
    assert.equal(store.list({ workspaceId: WORKSPACE }).total, 10);
  });
});

test('a failed import leaves no phantom record in the cache', () => {
  withDb('huqan-3208-rollback-', (open) => {
    const store = open();
    const good = { memoryId: 'aaaa0001', workspaceId: WORKSPACE, content: 'kept', createdAt: '2026-02-01T00:00:00.000Z',
      provenance: { provenanceId: 'p', sourceRef: 's', sourceTitle: 't', sourceType: 'import', actor: 'a',
        timestamp: '2026-02-01T00:00:00.000Z', workspaceId: WORKSPACE, trustPolicyVersion: '1.0.0', confidence: 1 },
      trustPolicyVersion: '1.0.0', metadata: {} };
    const conflicting = { ...good, content: 'different' };
    const pkg = (memories) => ({ version: '1.0.0', schemaVersion: '1.0.0', workspaceId: WORKSPACE,
      memories, events: [], links: [] });
    assert.equal(store.importPackage(pkg([good]), { targetWorkspaceId: WORKSPACE }).ok, true);
    const fresh = { ...good, memoryId: 'aaaa0002', content: 'rolled back' };
    const result = store.importPackage(pkg([fresh, conflicting]), { targetWorkspaceId: WORKSPACE, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.equal(store.get('aaaa0002', { workspaceId: WORKSPACE }).ok, false, 'rolled-back row is not served');
    assert.equal(store.list({ workspaceId: WORKSPACE }).total, 1);
  });
});

test('a corrupt row is reported at open and never served, with strict open still refusing', () => {
  withDb('huqan-3208-corrupt-', (open) => {
    const writer = open();
    seedStore(writer);
    writer._db.prepare('UPDATE memories SET content_json = ? WHERE workspace_id = ? AND memory_id = ?')
      .run('{not json', WORKSPACE, memoryId(1));
    writer.close();
    const store = open({ memoryCacheSize: 2 });
    assert.deepEqual(store.corruptRows.map((row) => [row.kind, row.id]), [['memory', memoryId(1)]]);
    assert.equal(store.get(memoryId(1), { workspaceId: WORKSPACE }).ok, false);
    assert.ok(!store.list({ workspaceId: WORKSPACE }).memories.some((m) => m.memoryId === memoryId(1)));
    assert.equal(store._memories.size, 45);
    assert.throws(() => open({ strictWarmup: true }), { code: 'MEMORY_STORE_CORRUPT_ROW' });
  });
});

test('an existing database with a malformed row still opens when the content-kind index is first built', () => {
  withDb('huqan-3208-upgrade-', (open) => {
    const writer = open();
    seedStore(writer);
    // A database from before #3208: no content-kind index, one malformed row.
    writer._db.exec('DROP INDEX idx_memories_workspace_content_kind');
    writer._db.prepare('UPDATE memories SET content_json = ? WHERE workspace_id = ? AND memory_id = ?')
      .run('{not json', OTHER_WORKSPACE, memoryId(0));
    writer.close();
    const store = open();
    assert.deepEqual(store.corruptRows.map((row) => row.id), [memoryId(0)]);
    assert.equal(store.list({ workspaceId: OTHER_WORKSPACE, contentKind: 'rule' }).total, 1);
  });
});

test('only a string content.kind matches a contentKind list, on the SQL path as in JS', () => {
  withDb('huqan-3208-kind-type-', (open) => {
    const store = open();
    for (const content of [{ kind: 'rule' }, { kind: { nested: 1 } }, { kind: ['rule'] }, { kind: 7 }, 'rule']) {
      assert.equal(store.store({ content, workspaceId: WORKSPACE }).ok, true);
    }
    const kinds = ['rule', '{"nested":1}', '["rule"]', '7'];
    const viaSql = kinds.map((kind) => store.list({ workspaceId: WORKSPACE, contentKind: kind }).total);
    store._memories.lookup = undefined;
    const readPage = store._recordReadContext;
    store._recordReadContext = function () { return { ...readPage.call(this), readPage: undefined }; };
    const viaJs = kinds.map((kind) => store.list({ workspaceId: WORKSPACE, contentKind: kind }).total);
    assert.deepEqual(viaSql, [1, 0, 0, 0]);
    assert.deepEqual(viaSql, viaJs);
  });
});

test('a record written this session reads the same on every path and after a restart', () => {
  withDb('huqan-3208-shape-', (open) => {
    const store = open();
    const written = store.store({ content: { kind: 'rule', text: 'shape' }, workspaceId: 'ws-shape' }).memory;
    const ws = { workspaceId: 'ws-shape' };
    const viaGet = store.get(written.memoryId, ws).memory;
    const viaPage = store.list(ws).memories[0];
    const viaKind = store.list({ ...ws, contentKind: 'rule' }).memories[0];
    const viaScan = store.query({ ...ws, contentIncludes: 'shape' }).memories[0];
    store.close();
    const restarted = open().get(written.memoryId, ws).memory;
    for (const read of [viaPage, viaKind, viaScan, restarted]) assert.deepEqual(read, viaGet);
  });
});

test('open scans and iteration cross chunk boundaries without dropping or reordering rows', () => {
  withDb('huqan-3208-chunks-', (open) => {
    const writer = open();
    const ids = [];
    for (let index = 0; index < 600; index++) {
      ids.push(writer.store({ content: `row ${index}`, workspaceId: 'ws-chunks' }).memory.memoryId);
    }
    // Past the first 256-row chunk, so only a continued scan can find it.
    writer._db.prepare('UPDATE memories SET metadata_json = ? WHERE memory_id = ?').run('{broken', ids[400]);
    writer.close();
    const store = open({ memoryCacheSize: 4 });
    assert.deepEqual(store.corruptRows.map((row) => row.id), [ids[400]]);
    const iterated = [...store._memories.values()].map((record) => record.memoryId);
    assert.deepEqual(iterated, ids.filter((_, index) => index !== 400), 'rowid order, corrupt row skipped');
    assert.equal(store._memories.size, 599);
  });
});

test('composite-key reads resolve workspace and memory ids that contain colons', () => {
  withDb('huqan-3208-colon-', (open) => {
    seedStore(open());
    const store = open({ memoryCacheSize: 2 });
    const byKey = (workspaceId, id) => store._memories.get(store.makeMemoryKey(workspaceId, id));
    assert.equal(byKey(OTHER_WORKSPACE, memoryId(0)).workspaceId, OTHER_WORKSPACE);
    assert.equal(byKey(WORKSPACE, memoryId(11)).memoryId, 'id:with:colon');
    assert.equal(byKey(WORKSPACE, 'no-such-id'), undefined);
    assert.equal(byKey(WORKSPACE, memoryId(11)), byKey(WORKSPACE, memoryId(11)), 'a second read is served from the cache');
  });
});
