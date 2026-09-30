'use strict';

// #3208 slice 2: a SQLite-backed MemoryStore reads events from SQLite instead
// of an in-memory array holding every row. Every event read must stay
// byte-identical to what the full array produced on main; the golden digests
// in test/fixtures/memory-event-read-golden.json were recorded there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MemoryStore = require('../lib/memory-store');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'memory-event-read-golden.json');
const WS = 'ws-events';
const OTHER = 'ws:events-other';

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
    provenanceId: `prov-${index}`, sourceRef: 'events', sourceTitle: 'Events', sourceType: 'import',
    actor: 'importer', timestamp: '2026-01-01T00:00:00.000Z', workspaceId, trustPolicyVersion: '1.0.0',
    confidence: 1,
  };
}

function memoryId(index) {
  return (0x2000 + index).toString(16).padStart(8, '0');
}

// Minute slots from 09:00; slots past 59 roll into the next hour.
function eventTime(slot) {
  const hour = String(9 + Math.floor(slot / 60)).padStart(2, '0');
  return `2026-02-02T${hour}:${String(slot % 60).padStart(2, '0')}:00.000Z`;
}

function buildPackage(workspaceId, memoryCount, eventCount) {
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
  const types = ['CREATED', 'UPDATED', 'TOMBSTONE', 'LINKED', 'REVIEWED'];
  const events = [];
  for (let index = 0; index < eventCount; index++) {
    const owner = index % memoryCount;
    events.push({
      eventId: `evt-${String(index).padStart(3, '0')}`,
      eventType: types[index % types.length],
      memoryId: memoryId(owner),
      workspaceId,
      // Triples share a timestamp so the signature tie-break is exercised.
      createdAt: eventTime(Math.floor(index / 3)),
      actor: index % 4 === 0 ? 'alice' : 'bob',
      provenance: provenance(100 + index, workspaceId),
      trustPolicyVersion: '1.0.0',
      details: index % 6 === 0 ? { note: `detail ${index}`, memoryId: memoryId((owner + 1) % memoryCount) }
        : { note: `detail ${index}` },
      relatedMemoryId: index % 7 === 0 ? memoryId((owner + 2) % memoryCount) : undefined,
    });
  }
  const links = [{
    linkId: 'lnk-001', relation: 'supports', fromMemoryId: memoryId(0), toMemoryId: memoryId(1), workspaceId,
    createdAt: '2026-02-03T00:00:00.000Z', provenance: provenance(900, workspaceId), trustPolicyVersion: '1.0.0',
  }];
  return { version: '1.0.0', schemaVersion: '1.0.0', workspaceId, memories, events, links };
}

function seedStore(store) {
  for (const [workspaceId, memories, events] of [[WS, 8, 60], [OTHER, 3, 9]]) {
    const result = store.importPackage(buildPackage(workspaceId, memories, events), { targetWorkspaceId: workspaceId });
    if (!result.ok) throw new Error(`event battery import failed: ${JSON.stringify(result.error)}`);
  }
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
  for (const index of [0, 2, 3, 7]) {
    record(`getEvents.${index}`, () => store.getEvents(memoryId(index), ws));
    record(`history.${index}`, () => store.history(memoryId(index), ws));
  }
  record('getEvents.other', () => store.getEvents(memoryId(0), { workspaceId: OTHER }));
  record('getEvents.missing', () => store.getEvents('ffffffff', ws));
  record('eventsForMemory', () => store.eventsForMemory(memoryId(1), ws));
  record('eventsForMemory.type', () => store.eventsForMemory(memoryId(1), { ...ws, eventType: 'UPDATED' }));
  record('eventsForMemory.range', () => store.eventsForMemory(memoryId(2), { ...ws,
    createdAfter: '2026-02-02T09:03:00.000Z', createdBefore: '2026-02-02T09:12:00.000Z' }));
  record('eventsForMemory.page', () => store.eventsForMemory(memoryId(0), { ...ws, limit: 2, offset: 1 }));
  record('eventsForMemory.unbounded', () => store.eventsForMemory(memoryId(0), { ...ws, limit: null }));
  record('eventsForMemory.missing', () => store.eventsForMemory('ffffffff', ws));
  record('eventsForMemory.badDate', () => store.eventsForMemory(memoryId(0), { ...ws, createdAfter: 'nope' }));
  record('timeline', () => store.timeline(ws));
  record('timeline.page', () => store.timeline({ ...ws, limit: 7, offset: 5 }));
  record('timeline.actor', () => store.timeline({ ...ws, actor: 'alice' }));
  record('timeline.type', () => store.timeline({ ...ws, eventType: 'TOMBSTONE' }));
  record('timeline.range', () => store.timeline({ ...ws, createdAfter: '2026-02-02T09:05:00.000Z',
    createdBefore: '2026-02-02T09:09:00.000Z' }));
  record('timeline.other', () => store.timeline({ workspaceId: OTHER }));
  record('timeline.badLimit', () => store.timeline({ ...ws, limit: 5000 }));
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
  record('reimport', () => store.importPackage(buildPackage(WS, 8, 60), { targetWorkspaceId: WS }));
  return JSON.parse(JSON.stringify(out));
}

function digests(results) {
  const out = {};
  for (const [name, value] of Object.entries(results)) {
    out[name] = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  return out;
}

// Each mode is pinned to its own digests. On main they differed in one
// place: a link's `metadata` was not persisted, so exports changed after a
// restart. Slice 3 persists it; the reopened export digests were re-recorded
// then and now equal the live ones.
function assertGolden(results, mode) {
  const actual = digests(results);
  if (process.env.UPDATE_MEMORY_READ_GOLDEN === '1') {
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({
      note: 'sha256 of JSON.stringify(result) per event read, per mode, recorded on origin/main (full in-memory event array) before #3208 slice 2. Regenerate only if a read contract changes on purpose: UPDATE_MEMORY_READ_GOLDEN=1 node --test test/memory-store-sqlite-events.test.js',
      digests: { ...(current.digests || {}), [mode]: actual },
    }, null, 2)}
`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')).digests[mode];
  const drifted = Object.keys(expected).filter((name) => expected[name] !== actual[name]);
  assert.deepEqual(drifted, [], `${mode}: event reads drifted from the main array`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
}

test('every event read matches the full-array golden, live and after reopening', () => {
  withDb('huqan-3208-events-golden-', (open) => {
    const writer = open();
    seedStore(writer);
    assertGolden(runBattery(writer), 'live');
    writer.close();
    assertGolden(runBattery(open({ memoryCacheSize: 2 })), 'reopened');
  });
});

test('opening a SQLite store keeps no events resident', () => {
  withDb('huqan-3208-events-open-', (open) => {
    seedStore(open());
    const store = open();
    assert.equal(Array.isArray(store._events), false, 'the SQLite backend is not a full event array');
  });
});

test('event reads and import dedupe never scan the whole event table', () => {
  withDb('huqan-3208-events-scoped-', (open) => {
    seedStore(open());
    const store = open();
    store._events.values = () => { throw new Error('full event scan'); };
    store._events[Symbol.iterator] = () => { throw new Error('full event scan'); };
    assert.equal(store.getEvents(memoryId(0), { workspaceId: WS }).length > 0, true);
    assert.equal(store.eventsForMemory(memoryId(0), { workspaceId: WS }).ok, true);
    assert.equal(store.timeline({ workspaceId: WS }).total, 60);
    assert.equal(store.history(memoryId(2), { workspaceId: WS }).ok, true);
    assert.equal(store.exportPackage({ workspaceId: WS }).ok, true);
    assert.equal(store.importPackage(buildPackage(WS, 8, 60), { targetWorkspaceId: WS }).skipped.events, 60);
  });
});

test('an imported review stamp survives a restart', () => {
  withDb('huqan-3208-events-review-', (open) => {
    const pkg = buildPackage(WS, 2, 2);
    pkg.events[0].reviewedAt = '2026-02-05T00:00:00.000Z';
    pkg.events[0].reviewedBy = 'ali';
    const writer = open();
    assert.equal(writer.importPackage(pkg, { targetWorkspaceId: WS }).ok, true);
    const live = writer.getEvents(memoryId(0), { workspaceId: WS });
    writer.close();
    const restarted = open().getEvents(memoryId(0), { workspaceId: WS });
    assert.equal(restarted[0].reviewedAt, '2026-02-05T00:00:00.000Z');
    assert.equal(restarted[0].reviewedBy, 'ali');
    assert.deepEqual(restarted, live);
  });
});

test('a database from before the review columns opens and keeps its events', () => {
  withDb('huqan-3208-events-upgrade-', (open) => {
    const writer = open();
    seedStore(writer);
    const columns = writer._db.prepare('PRAGMA table_info(memory_events)').all().map((column) => column.name);
    if (columns.includes('reviewed_at')) {
      writer._db.exec('ALTER TABLE memory_events DROP COLUMN reviewed_at');
      writer._db.exec('ALTER TABLE memory_events DROP COLUMN reviewed_by');
    }
    writer.close();
    const store = open();
    assert.equal(store.timeline({ workspaceId: WS }).total, 60);
    assert.equal(store.corruptRows.length, 0);
  });
});

test('a corrupt event row is reported at open and never served', () => {
  withDb('huqan-3208-events-corrupt-', (open) => {
    const writer = open();
    seedStore(writer);
    writer._db.prepare('UPDATE memory_events SET details_json = ? WHERE workspace_id = ? AND event_id = ?')
      .run('{broken', WS, 'evt-001');
    writer.close();
    const store = open();
    assert.deepEqual(store.corruptRows.map((row) => [row.kind, row.id]), [['event', 'evt-001']]);
    assert.equal(store.timeline({ workspaceId: WS, limit: null }).total, 59);
    assert.ok(!store.getEvents(memoryId(1), { workspaceId: WS }).some((event) => event.eventId === 'evt-001'));
    assert.ok(!store.exportPackage({ workspaceId: WS }).package.events.some((event) => event.eventId === 'evt-001'));
    assert.throws(() => open({ strictWarmup: true }), { code: 'MEMORY_STORE_CORRUPT_ROW' });
  });
});

test('a rolled-back import leaves no phantom events', () => {
  withDb('huqan-3208-events-rollback-', (open) => {
    const store = open();
    assert.equal(store.importPackage(buildPackage(WS, 2, 0), { targetWorkspaceId: WS }).ok, true);
    const pkg = buildPackage(WS, 2, 4);
    // A link to a memory the package does not carry is a conflict; strict
    // mode throws after the events were written, rolling them back.
    pkg.links[0].toMemoryId = 'ffffffff';
    const result = store.importPackage(pkg, { targetWorkspaceId: WS, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.equal(store.timeline({ workspaceId: WS }).total, 0);
    assert.deepEqual(store.getEvents(memoryId(0), { workspaceId: WS }), []);
  });
});

test('events written this session read the same after a restart', () => {
  withDb('huqan-3208-events-live-', (open) => {
    const store = open();
    const ws = { workspaceId: WS };
    const a = store.store({ content: 'a', workspaceId: WS }).memory;
    const b = store.store({ content: 'b', workspaceId: WS }).memory;
    store.patchMetadata(a.memoryId, { tag: 1 }, ws);
    store.linkMemories({ fromMemoryId: a.memoryId, toMemoryId: b.memoryId, relation: 'supports', workspaceId: WS });
    const superseded = store.supersede(b.memoryId, 'b2', ws);
    store.tombstone(a.memoryId, ws);
    const reads = (s) => ({
      a: s.history(a.memoryId, ws), b: s.history(b.memoryId, ws),
      newer: s.history(superseded.newMemory.memoryId, ws), timeline: s.timeline(ws),
    });
    const live = JSON.parse(JSON.stringify(reads(store)));
    store.close();
    assert.deepEqual(JSON.parse(JSON.stringify(reads(open()))), live);
    assert.ok(live.timeline.total >= 6);
    // Freshly written events carry the stamped schemaVersion, live and after a
    // restart; the table used to drop it.
    assert.ok(live.timeline.events.every((event) => event.schemaVersion === '1.0.0'));
  });
});

test('open scans and exports cross event chunk boundaries in insertion order', () => {
  withDb('huqan-3208-events-chunks-', (open) => {
    const writer = open();
    const pkg = buildPackage(WS, 4, 600);
    assert.equal(writer.importPackage(pkg, { targetWorkspaceId: WS }).ok, true);
    writer._db.prepare('UPDATE memory_events SET provenance_json = ? WHERE event_id = ?').run('{broken', 'evt-400');
    writer.close();
    const store = open();
    assert.deepEqual(store.corruptRows.map((row) => row.id), ['evt-400']);
    const exported = store.exportPackage({ workspaceId: WS, includeTombstoned: true }).package.events
      .map((event) => event.eventId);
    const expected = pkg.events.map((event) => event.eventId).filter((id) => id !== 'evt-400');
    assert.deepEqual(exported, expected.filter((id) => exported.includes(id)), 'insertion (rowid) order');
    assert.equal(store.timeline({ workspaceId: WS, limit: null }).total, 599);
  });
});

test('re-importing over a corrupt event row fails as it did with the event array', () => {
  withDb('huqan-3208-events-reimport-corrupt-', (open) => {
    const writer = open();
    assert.equal(writer.importPackage(buildPackage(WS, 2, 2), { targetWorkspaceId: WS }).ok, true);
    writer._db.prepare('UPDATE memory_events SET details_json = ? WHERE event_id = ?').run('{broken', 'evt-000');
    writer.close();
    // The corrupt row is not an event the store serves, so the import tries to
    // write it again and hits the primary key -- the array-backed behaviour.
    const result = open().importPackage(buildPackage(WS, 2, 2), { targetWorkspaceId: WS });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PERSISTENCE_ERROR');
  });
});
