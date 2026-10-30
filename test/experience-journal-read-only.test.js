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

test('supplied readonly snapshot stays pinned without opening or reading its missing pathname', t => {
  const f = setup(t), writer = f.open();
  const expected = readSealedRun(writeRun(writer), 'sealed', 'ws'); writer.close();
  const snapshotBytes = fs.readFileSync(f.dbPath), original = Buffer.from(snapshotBytes);
  fs.rmSync(f.dbPath);
  let opens = 0, reads = 0;
  const stopOpen = t.mock.method(fs, 'openSync', () => { opens++; throw new Error('unexpected file open'); });
  const stopRead = t.mock.method(fs, 'readFileSync', () => { reads++; throw new Error('unexpected file read'); });
  const stopReadFd = t.mock.method(fs, 'readSync', () => { reads++; throw new Error('unexpected fd read'); });
  const stopStat = t.mock.method(fs, 'statSync', () => { reads++; throw new Error('unexpected path stat'); });
  const stopRealpath = t.mock.method(fs.realpathSync, 'native', () => { reads++; throw new Error('unexpected realpath read'); });
  let reader;
  try {
    reader = openJournalConnection({ dbPath: f.dbPath, readOnly: true, snapshotBytes });
    assert.ok(reader, 'a supplied snapshot must not reopen its source pathname');
    assert.equal(reader.db.readonly, true);
    assert.deepEqual(readSealedRun(createExperienceJournal({ store: reader, readOnly: true }), 'sealed', 'ws'), expected);
    assert.deepEqual(snapshotBytes, original, 'header normalization does not mutate caller bytes');
    snapshotBytes.fill(0); reader.close(); reader.reopen();
    assert.equal(reader.db.readonly, true);
    assert.deepEqual(readSealedRun(createExperienceJournal({ store: reader, readOnly: true }), 'sealed', 'ws'), expected);
    assert.throws(() => reader.db.exec('CREATE TABLE forbidden(value)'), /readonly|read-only/i);
    assert.equal(opens, 0); assert.equal(reads, 0);
  } finally {
    reader?.close();
    for (const method of [stopOpen, stopRead, stopReadFd, stopStat, stopRealpath]) method.mock.restore();
  }
});

test('supplied snapshot ignores replacement pathname contents and reopens the same private bytes', t => {
  const f = setup(t), writer = f.open();
  const expected = readSealedRun(writeRun(writer), 'sealed', 'ws'); writer.close();
  const snapshotBytes = fs.readFileSync(f.dbPath), original = Buffer.from(snapshotBytes);
  fs.rmSync(f.dbPath);
  const replacement = f.open(); writeRun(replacement, 'replacement'); replacement.close();
  const before = files(f.dir);
  const reader = openJournalConnection({ dbPath: f.dbPath, readOnly: true, snapshotBytes });
  assert.ok(reader);
  try {
    const journal = createExperienceJournal({ store: reader, readOnly: true });
    assert.deepEqual(journal.runIds('ws'), ['sealed']);
    assert.deepEqual(readSealedRun(journal, 'sealed', 'ws'), expected);
    assert.deepEqual(snapshotBytes, original);
    reader.close(); snapshotBytes.fill(0); reader.reopen();
    assert.deepEqual(readSealedRun(createExperienceJournal({ store: reader, readOnly: true }), 'sealed', 'ws'), expected);
    assert.deepEqual(files(f.dir), before);
  } finally { reader.close(); }
});

test('supplied snapshot validation cannot create a writer or change caller bytes', t => {
  const f = setup(t), writer = f.open(); writeRun(writer); writer.close();
  const bytes = fs.readFileSync(f.dbPath);
  const missing = path.join(f.dir, 'missing.db'), before = files(f.dir);
  const corrupt = Buffer.alloc(100); corrupt.write('SQLite format 3\0'); corrupt[18] = 1; corrupt[19] = 1;
  for (const snapshotBytes of [undefined, null, bytes.toString('base64'), new Uint8Array(bytes),
    bytes.buffer, Buffer.alloc(0), Buffer.alloc(100), corrupt])
    assert.equal(openJournalConnection({ dbPath: missing, readOnly: true, snapshotBytes }), null);
  for (const [writeVersion, readVersion] of [[0, 0], [1, 2], [2, 1], [3, 3]]) {
    const snapshotBytes = Buffer.from(bytes); snapshotBytes[18] = writeVersion; snapshotBytes[19] = readVersion;
    const original = Buffer.from(snapshotBytes);
    assert.equal(openJournalConnection({ dbPath: missing, readOnly: true, snapshotBytes }), null);
    assert.deepEqual(snapshotBytes, original);
  }
  for (const readOnly of [false, undefined, null, 'true'])
    assert.equal(openJournalConnection({ dbPath: missing, readOnly, snapshotBytes: bytes }), null);
  for (const dbPath of ['', ':memory:', 'file::memory:'])
    assert.equal(openJournalConnection({ dbPath, readOnly: true, snapshotBytes: bytes }), null);
  for (const version of [1, 2]) {
    const snapshotBytes = Buffer.from(bytes); snapshotBytes[18] = version; snapshotBytes[19] = version;
    const original = Buffer.from(snapshotBytes);
    const reader = openJournalConnection({ dbPath: missing, readOnly: true, snapshotBytes });
    try { assert.ok(reader); assert.equal(reader.db.readonly, true); assert.deepEqual(snapshotBytes, original); }
    finally { reader?.close(); }
  }
  assert.deepEqual(files(f.dir), before);
});

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
