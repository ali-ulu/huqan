'use strict';

// #3208 slice 3: a SQLite-backed MemoryStore reads links from SQLite instead
// of an in-memory array holding every row. On main, the array answered the
// live session but memory_links dropped a link's `metadata` and
// `schemaVersion`, so the same reads answered differently after a restart.
// The golden digests in test/fixtures/memory-link-read-golden.json were
// recorded on main from the live session; both the live and the reopened
// store must now match them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'memory-link-read-golden.json');
const WS = 'ws-links';
const OTHER = 'ws:links-other';
const RELATIONS = ['supports', 'references', 'related_to', 'contradicts', 'supersedes'];

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

function provenance(index, workspaceId) {
  return {
    provenanceId: `prov-${index}`, sourceRef: 'links', sourceTitle: 'Links', sourceType: 'import',
    actor: 'importer', timestamp: '2026-01-01T00:00:00.000Z', workspaceId, trustPolicyVersion: '1.0.0',
    confidence: 1,
  };
}

function memoryId(index) {
  return (0x3000 + index).toString(16).padStart(8, '0');
}

// Minute slots from 00:00; slots past 59 roll into the next hour.
function linkTime(slot) {
  const hour = String(Math.floor(slot / 60)).padStart(2, '0');
  return `2026-02-03T${hour}:${String(slot % 60).padStart(2, '0')}:00.000Z`;
}

function buildPackage(workspaceId, memoryCount, linkCount) {
  const memories = [];
  for (let index = 0; index < memoryCount; index++) {
    memories.push({
      memoryId: memoryId(index), workspaceId, content: `memory ${index}`,
      createdAt: `2026-02-01T10:${String(index).padStart(2, '0')}:00.000Z`,
      status: index === 3 ? 'deleted' : 'active',
      deletedAt: index === 3 ? '2026-04-01T00:00:00.000Z' : undefined,
      metadata: {}, provenance: provenance(index, workspaceId), trustPolicyVersion: '1.0.0',
    });
  }
  const links = [];
  for (let index = 0; index < linkCount; index++) {
    const from = index % memoryCount;
    const to = (from + 1 + (index % 3)) % memoryCount;
    if (from === to) continue;
    links.push({
      linkId: `lnk-${String(index).padStart(3, '0')}`,
      relation: RELATIONS[index % RELATIONS.length],
      fromMemoryId: memoryId(from),
      toMemoryId: memoryId(to),
      workspaceId,
      // Pairs share a timestamp so the signature tie-break is exercised.
      createdAt: linkTime(Math.floor(index / 2)),
      provenance: provenance(500 + index, workspaceId),
      trustPolicyVersion: '1.0.0',
      strength: index % 4 === 0 ? undefined : (index % 10) / 10,
      metadata: index % 3 === 0 ? {} : { note: `link ${index}`, weight: index },
    });
  }
  return { version: '1.0.0', schemaVersion: '1.0.0', workspaceId, memories, events: [], links };
}

function seedStore(store) {
  for (const [workspaceId, memories, links] of [[WS, 8, 30], [OTHER, 3, 4]]) {
    const result = store.importPackage(buildPackage(workspaceId, memories, links), { targetWorkspaceId: workspaceId });
    if (!result.ok) throw new Error(`link battery import failed: ${JSON.stringify(result.error)}`);
  }
  // Links written through the live API carry schemaVersion and metadata.
  const linked = store.linkMemories({
    fromMemoryId: memoryId(6), toMemoryId: memoryId(0), relation: 'references', workspaceId: WS,
    confidence: 0.25, metadata: { reason: 'live write', tags: ['a', 'b'] },
  });
  if (!linked.ok) throw new Error(`linkMemories failed: ${JSON.stringify(linked.error)}`);
  const contradicted = store.contradict(memoryId(7), memoryId(1), { workspaceId: WS, strength: 0.5 });
  if (!contradicted.ok) throw new Error(`contradict failed: ${JSON.stringify(contradicted.error)}`);
}

// linkMemories stamps the wall clock into createdAt and provenance; the
// battery reads everything else, so those two fields are pinned before
// digesting.
function stable(value) {
  return JSON.parse(JSON.stringify(value, (key, field) => {
    if (key === 'createdAt' && typeof field === 'string' && field >= '2026-03-01') return '<now>';
    if (key === 'timestamp' && typeof field === 'string' && field >= '2026-03-01') return '<now>';
    if (key === 'provenanceId' && typeof field === 'string' && !field.startsWith('prov-')) return '<generated>';
    if (key === 'eventId' && typeof field === 'string') return '<generated>';
    return field;
  }));
}

function runBattery(store) {
  const ws = { workspaceId: WS };
  const out = {};
  const record = (name, fn) => {
    try {
      out[name] = fn();
    } catch (error) {
      out[name] = { threw: error.message };
    }
  };
  for (const index of [0, 1, 3, 6]) {
    record(`getLinks.${index}`, () => store.getLinks(memoryId(index), ws));
    record(`getBacklinks.${index}`, () => store.getBacklinks(memoryId(index), ws));
    record(`findLinks.${index}`, () => store.findLinks(memoryId(index), ws));
    record(`linksForMemory.${index}`, () => store.linksForMemory(memoryId(index), ws));
  }
  record('getLinks.other', () => store.getLinks(memoryId(0), { workspaceId: OTHER }));
  record('getLinks.missing', () => store.getLinks('ffffffff', ws));
  record('findLinks.outgoing', () => store.findLinks(memoryId(2), { ...ws, direction: 'outgoing' }));
  record('findLinks.incoming', () => store.findLinks(memoryId(2), { ...ws, direction: 'incoming' }));
  record('findLinks.relation', () => store.findLinks(memoryId(2), { ...ws, relation: 'supports' }));
  record('findLinks.badDirection', () => store.findLinks(memoryId(2), { ...ws, direction: 'sideways' }));
  record('findLinkedMemories', () => store.findLinkedMemories(memoryId(1), ws));
  record('findLinkedMemories.tombstoned', () => store.findLinkedMemories(memoryId(2), { ...ws, includeTombstoned: true }));
  record('traverse.1', () => store.traverseLinks(memoryId(0), ws));
  record('traverse.3', () => store.traverseLinks(memoryId(0), { ...ws, maxDepth: 3 }));
  record('traverse.outgoing', () => store.traverseLinks(memoryId(1), { ...ws, maxDepth: 4, direction: 'outgoing' }));
  record('traverse.relation', () => store.traverseLinks(memoryId(1), { ...ws, maxDepth: 4, relation: 'related_to' }));
  record('traverse.tombstonedRoot', () => store.traverseLinks(memoryId(3), ws));
  record('queryLinks', () => store.queryLinks(ws));
  record('queryLinks.page', () => store.queryLinks({ ...ws, limit: 4, offset: 3 }));
  record('queryLinks.unbounded', () => store.queryLinks({ ...ws, limit: null }));
  record('queryLinks.from', () => store.queryLinks({ ...ws, fromMemoryId: memoryId(2) }));
  record('queryLinks.to', () => store.queryLinks({ ...ws, toMemoryId: memoryId(4) }));
  record('queryLinks.relation', () => store.queryLinks({ ...ws, relation: 'references' }));
  record('queryLinks.deleted', () => store.queryLinks({ ...ws, includeDeleted: true }));
  record('queryLinks.other', () => store.queryLinks({ workspaceId: OTHER }));
  record('queryLinks.badRelation', () => store.queryLinks({ ...ws, relation: 'owns' }));
  record('linksForMemory.outgoing', () => store.linksForMemory(memoryId(4), { ...ws, direction: 'outgoing' }));
  record('linksForMemory.deleted', () => store.linksForMemory(memoryId(3), { ...ws, includeDeleted: true }));
  record('export', () => {
    const result = store.exportPackage(ws);
    if (result.package) delete result.package.exportedAt;
    return result;
  });
  record('export.tombstoned', () => {
    const result = store.exportPackage({ ...ws, includeTombstoned: true });
    if (result.package) delete result.package.exportedAt;
    return result;
  });
  record('reimport', () => store.importPackage(buildPackage(WS, 8, 30), { targetWorkspaceId: WS }));
  record('relink', () => store.linkMemories({
    fromMemoryId: memoryId(6), toMemoryId: memoryId(0), relation: 'references', workspaceId: WS,
  }));
  return stable(out);
}

function digests(results) {
  const out = {};
  for (const [name, value] of Object.entries(results)) {
    out[name] = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  return out;
}

function assertGolden(results, mode) {
  const actual = digests(results);
  if (process.env.UPDATE_MEMORY_READ_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({
      note: 'sha256 of JSON.stringify(result) per link read, recorded on origin/main from the live session (full in-memory link array) before #3208 slice 3. Regenerate only if a read contract changes on purpose: UPDATE_MEMORY_READ_GOLDEN=1 node --test test/memory-store-sqlite-links.test.js',
      digests: actual,
    }, null, 2)}
`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')).digests;
  const drifted = Object.keys(expected).filter((name) => expected[name] !== actual[name]);
  assert.deepEqual(drifted, [], `${mode}: link reads drifted from the main live session`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
}

test('every link read matches the live golden, live and after reopening', () => {
  withDb('huqan-3208-links-golden-', (open) => {
    const writer = open();
    seedStore(writer);
    assertGolden(runBattery(writer), 'live');
    if (process.env.UPDATE_MEMORY_READ_GOLDEN === '1') return;
    writer.close();
    assertGolden(runBattery(open({ memoryCacheSize: 2 })), 'reopened');
  });
});

test('opening a SQLite store keeps no links resident', () => {
  withDb('huqan-3208-links-open-', (open) => {
    seedStore(open());
    const store = open();
    assert.equal(Array.isArray(store._links), false, 'the SQLite backend is not a full link array');
  });
});

test('link reads and import dedupe never scan the whole link table', () => {
  withDb('huqan-3208-links-scoped-', (open) => {
    seedStore(open());
    const store = open();
    const scan = () => { throw new Error('full link scan'); };
    store._links.filter = scan;

    store._links[Symbol.iterator] = scan;
    const ws = { workspaceId: WS };
    assert.ok(store.getLinks(memoryId(0), ws).length > 0);
    assert.equal(store.findLinks(memoryId(0), ws).ok, true);
    assert.equal(store.traverseLinks(memoryId(0), { ...ws, maxDepth: 3 }).ok, true);
    assert.equal(store.queryLinks({ ...ws, fromMemoryId: memoryId(2) }).ok, true);
    assert.equal(store.linksForMemory(memoryId(1), ws).ok, true);
    assert.equal(store.exportPackage(ws).ok, true);
    assert.equal(store.importPackage(buildPackage(WS, 8, 30), { targetWorkspaceId: WS }).skipped.links, 30);
    assert.equal(store.linkMemories({
      fromMemoryId: memoryId(6), toMemoryId: memoryId(0), relation: 'references', workspaceId: WS,
    }).ok, true);
  });
});

test('a live link keeps its metadata and schemaVersion across a restart', () => {
  withDb('huqan-3208-links-restart-', (open) => {
    const writer = open();
    const ws = { workspaceId: WS };
    const a = writer.store({ content: 'a', workspaceId: WS }).memory;
    const b = writer.store({ content: 'b', workspaceId: WS }).memory;
    const linked = writer.linkMemories({
      fromMemoryId: a.memoryId, toMemoryId: b.memoryId, relation: 'supports', workspaceId: WS,
      metadata: { reason: 'restart' },
    });
    assert.equal(linked.ok, true);
    const live = writer.getLinks(a.memoryId, ws);
    writer.close();
    const restarted = open().getLinks(a.memoryId, ws);
    assert.deepEqual(restarted[0].metadata, { reason: 'restart' });
    assert.equal(restarted[0].schemaVersion, live[0].schemaVersion);
    assert.deepEqual(restarted, live);
  });
});

test('a database from before the link columns opens and keeps its links', () => {
  withDb('huqan-3208-links-upgrade-', (open) => {
    const writer = open();
    seedStore(writer);
    writer._db.exec('ALTER TABLE memory_links DROP COLUMN metadata_json');
    writer._db.exec('ALTER TABLE memory_links DROP COLUMN schema_version');
    writer.close();
    const store = open();
    const links = store.queryLinks({ workspaceId: WS, limit: null, includeDeleted: true }).links;
    assert.equal(links.length, 32);
    // Rows written before read back as they did on main: no schemaVersion,
    // and the read API's empty-metadata default.
    assert.ok(links.every((link) => link.schemaVersion === undefined));
    assert.ok(links.every((link) => JSON.stringify(link.metadata) === '{}'));
    assert.equal(store.corruptRows.length, 0);
  });
});

test('a corrupt link row is reported at open and never served', () => {
  withDb('huqan-3208-links-corrupt-', (open) => {
    const writer = open();
    seedStore(writer);
    writer._db.prepare('UPDATE memory_links SET metadata_json = ? WHERE workspace_id = ? AND link_id = ?')
      .run('{broken', WS, 'lnk-001');
    writer.close();
    const store = open();
    assert.deepEqual(store.corruptRows.map((row) => [row.kind, row.id]), [['link', 'lnk-001']]);
    const ws = { workspaceId: WS };
    assert.ok(!store.queryLinks({ ...ws, limit: null, includeDeleted: true }).links
      .some((link) => link.linkId === 'lnk-001'));
    assert.ok(!store.getLinks(memoryId(1), ws).some((link) => link.linkId === 'lnk-001'));
    assert.ok(!store.exportPackage(ws).package.links.some((link) => link.linkId === 'lnk-001'));
    assert.throws(() => open({ strictWarmup: true }), { code: 'MEMORY_STORE_CORRUPT_ROW' });
  });
});

test('a rolled-back import leaves no phantom links', () => {
  withDb('huqan-3208-links-rollback-', (open) => {
    const store = open();
    assert.equal(store.importPackage(buildPackage(WS, 4, 0), { targetWorkspaceId: WS }).ok, true);
    const pkg = buildPackage(WS, 4, 6);
    // A dangling endpoint is a conflict; strict mode throws after the earlier
    // links were written, rolling them back.
    pkg.links[pkg.links.length - 1].toMemoryId = 'ffffffff';
    const result = store.importPackage(pkg, { targetWorkspaceId: WS, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.equal(store.queryLinks({ workspaceId: WS, limit: null, includeDeleted: true }).total, 0);
    assert.deepEqual(store.getLinks(memoryId(0), { workspaceId: WS }), []);
  });
});

test('open scans and exports cross link chunk boundaries in insertion order', () => {
  withDb('huqan-3208-links-chunks-', (open) => {
    const writer = open();
    const pkg = buildPackage(WS, 5, 600);
    assert.equal(writer.importPackage(pkg, { targetWorkspaceId: WS }).ok, true);
    writer._db.prepare('UPDATE memory_links SET provenance_json = ? WHERE link_id = ?').run('{broken', 'lnk-400');
    writer.close();
    const store = open();
    assert.deepEqual(store.corruptRows.map((row) => row.id), ['lnk-400']);
    const exported = store.exportPackage({ workspaceId: WS, includeTombstoned: true }).package.links
      .map((link) => link.linkId);
    const expected = pkg.links.map((link) => link.linkId).filter((id) => id !== 'lnk-400');
    assert.deepEqual(exported, expected, 'insertion (rowid) order');
  });
});
