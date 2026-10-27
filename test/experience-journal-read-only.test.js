'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { createExperienceJournal } = require('../lib/experience/journal');
const { readSealedRun } = require('../lib/experience/learning-intake');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-read-only-'));
  const handles = [];
  t.after(() => {
    for (const handle of handles) handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'graph.json'), '{"untouched":true}');
  const dbPath = path.join(dir, 'journal.db');
  const open = (readOnly = false) => {
    const handle = openJournalConnection({ dbPath, readOnly });
    if (handle) handles.push(handle);
    return handle;
  };
  return { dir, dbPath, open };
}

function files(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
}

function writeRun(store, runId = 'sealed', closed = true) {
  const journal = createExperienceJournal({ store });
  const append = (eventId, type, rest = {}) => assert.equal(journal.append({
    workspaceId: 'ws', runId, eventId, type, ...rest,
  }).ok, true);
  append('start', 'run_started');
  append('finish', 'execution_finished', { executionStatus: 'completed' });
  append('verify', 'verification', { verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true } });
  if (closed) append('close', 'run_closed');
  return journal;
}

test('readonly connection reuses sealed reads and cannot write or create sidecars', t => {
  const f = setup(t);
  const writer = f.open();
  const original = writeRun(writer);
  const expected = readSealedRun(original, 'sealed', 'ws');
  assert.equal(expected.ok, true);
  writer.close();
  const before = files(f.dir);
  const reader = f.open(true);
  assert.ok(reader);
  assert.equal(reader.db.readonly, true);
  const journal = createExperienceJournal({ store: reader, readOnly: true });
  assert.deepEqual(readSealedRun(journal, 'sealed', 'ws'), expected);
  assert.deepEqual(journal.runIds('ws'), ['sealed']);
  assert.deepEqual(journal.runIds('other'), []);
  assert.equal(readSealedRun(journal, 'sealed', 'other').code, 'workspace_mismatch');
  assert.equal(readSealedRun(journal, 'missing', 'ws').code, 'run_not_found');
  assert.equal(journal.append, undefined);
  assert.equal(journal.close, undefined);
  assert.throws(() => reader.db.exec('CREATE TABLE forbidden(value)'), /readonly|read-only/i);
  assert.deepEqual(files(f.dir), before);
  reader.close();
  assert.deepEqual(files(f.dir), before);
});

test('readonly open refuses missing and invalid files without creating a database', t => {
  const f = setup(t);
  const before = files(f.dir);
  assert.equal(f.open(true), null);
  assert.deepEqual(files(f.dir), before);
  fs.writeFileSync(f.dbPath, 'not a sqlite file');
  const invalid = files(f.dir);
  assert.equal(f.open(true), null);
  assert.deepEqual(files(f.dir), invalid);
});

test('readonly reader refuses live WAL rather than omitting its committed records', t => {
  const f = setup(t);
  const writer = f.open();
  writeRun(writer);
  assert.ok(fs.statSync(`${f.dbPath}-wal`).size > 0);
  const before = files(f.dir);
  assert.equal(f.open(true), null);
  assert.deepEqual(files(f.dir), before);
});

test('readonly reader rejects a hardlink alias hiding another filename WAL', t => {
  const f = setup(t);
  const checkpoint = f.open();
  writeRun(checkpoint, 'checkpointed');
  checkpoint.close();
  const alias = path.join(f.dir, 'alias.db');
  fs.linkSync(f.dbPath, alias);
  assert.ok(fs.statSync(alias, { bigint: true }).nlink > 1n);
  const writer = f.open();
  writeRun(writer, 'pending');
  assert.ok(fs.statSync(`${f.dbPath}-wal`).size > 0);
  assert.equal(fs.existsSync(`${alias}-wal`), false);
  const before = files(f.dir);
  const reader = openJournalConnection({ dbPath: alias, readOnly: true });
  try { assert.equal(reader, null); } finally { reader?.close(); }
  assert.deepEqual(files(f.dir), before);
});

test('readonly reader refuses a nonempty rollback sidecar without touching files', t => {
  const f = setup(t);
  const writer = f.open();
  writeRun(writer);
  writer.close();
  fs.writeFileSync(`${f.dbPath}-journal`, 'pending rollback data');
  const before = files(f.dir);
  assert.equal(f.open(true), null);
  assert.deepEqual(files(f.dir), before);
});

test('readonly reopen reloads a checkpoint but refuses a newly pending WAL', t => {
  const f = setup(t);
  const writer = f.open();
  const expected = readSealedRun(writeRun(writer), 'sealed', 'ws');
  writer.close();
  const reader = f.open(true);
  assert.ok(reader);
  reader.close();
  assert.equal(reader.db, null);
  const before = files(f.dir);
  reader.reopen();
  assert.equal(reader.db.readonly, true);
  assert.deepEqual(readSealedRun(createExperienceJournal({ store: reader, readOnly: true }), 'sealed', 'ws'), expected);
  assert.deepEqual(files(f.dir), before);
  reader.close();
  fs.writeFileSync(`${f.dbPath}-wal`, 'pending WAL data');
  const pending = files(f.dir);
  reader.reopen();
  assert.equal(reader.db, null);
  assert.deepEqual(files(f.dir), pending);
});

test('readonly journal never creates its missing table', t => {
  const f = setup(t);
  const writer = f.open();
  writer.db.exec('CREATE TABLE unrelated(value)');
  writer.close();
  const before = files(f.dir);
  const reader = f.open(true);
  assert.ok(reader);
  assert.throws(() => createExperienceJournal({ store: reader, readOnly: true }), /no such table: experience_journal/);
  assert.deepEqual(files(f.dir), before);
});

test('invalid readonly flags cannot fall back to a database-creating writer', t => {
  const f = setup(t);
  const before = files(f.dir);
  for (const readOnly of ['true', 1, null]) {
    assert.equal(openJournalConnection({ dbPath: f.dbPath, readOnly }), null);
    assert.throws(() => createExperienceJournal({ readOnly }), /readOnly must be boolean/);
  }
  assert.deepEqual(files(f.dir), before);
});

test('readonly journal requires a readonly handle and cannot close an open source run', t => {
  const f = setup(t);
  const writer = f.open();
  writeRun(writer, 'open', false);
  assert.throws(() => createExperienceJournal({ store: writer, readOnly: true }), /read.only/i);
  writer.close();
  const reader = f.open(true);
  assert.ok(reader);
  const journal = createExperienceJournal({ store: reader, readOnly: true });
  assert.equal(readSealedRun(journal, 'open', 'ws').code, 'run_not_sealed');
  assert.equal(journal.close, undefined);
});

test('readonly rebuild preserves integrity failure for an externally altered record', t => {
  const f = setup(t);
  const writer = f.open();
  writeRun(writer);
  writer.db.prepare("UPDATE experience_journal SET hash = 'tampered'").run();
  writer.close();
  const before = files(f.dir);
  const reader = f.open(true);
  assert.ok(reader);
  assert.throws(() => createExperienceJournal({ store: reader, readOnly: true }), { code: 'INTEGRITY_MISMATCH' });
  reader.close();
  assert.deepEqual(files(f.dir), before);
});
