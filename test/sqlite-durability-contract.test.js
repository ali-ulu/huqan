'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MemoryStore = require('../lib/memory-store');
const { sqlitePragmaSql } = require('../lib/graph-sqlite-pragmas');

/**
 * Which stores promise their contents survive a power cut.
 *
 * The settings were split across four files with the reason recorded in only
 * one of them, so a chosen value and a defaulted one were indistinguishable in
 * source. This pins the decision itself: an evidence store fsyncs, and the two
 * that deliberately do not are named here rather than left to be discovered.
 */

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-durability-'));
  const store = new MemoryStore({
    useSQLite: true,
    dbPath: path.join(dir, 'memory-store.db'),
    memoryPath: path.join(dir, 'memory-store.json'),
  });
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the memory store fsyncs on commit, because memory_events is an audit trail', () => {
  // actor, provenance_json, trust_policy_version, one row per mutation -- and
  // not derived: memory-store-sqlite-warmup replays every row at startup, so
  // the table is the record. Under WAL, NORMAL does not fsync, so a power loss
  // drops the tail of that trail with nothing showing a gap.
  withStore((store) => {
    const [{ synchronous }] = store._db.pragma('synchronous');
    assert.equal(synchronous, 2, 'synchronous must be FULL (2), not NORMAL (1)');
  });
});

test('the memory store still runs in WAL', () => {
  // FULL without WAL would be a different and much slower trade.
  withStore((store) => {
    const [{ journal_mode: journalMode }] = store._db.pragma('journal_mode');
    assert.equal(String(journalMode).toLowerCase(), 'wal');
  });
});

test('the canonical graph makes the same promise', () => {
  // The graph carries mutation_receipts and has said FULL since #1432. The
  // memory store now matches it rather than quietly offering less.
  const sql = sqlitePragmaSql({});
  assert.match(sql, /PRAGMA synchronous = FULL;/);
  assert.match(sql, /PRAGMA journal_mode = WAL;/);
});

test('the replay store makes the same promise', () => {
  // Its durability is what makes at-most-once delivery hold across a restart.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'external-client-replay-store.js'), 'utf8');
  assert.match(source, /pragma\('synchronous = FULL'\)/);
});

test('the store that deliberately does not fsync says so, and says why', () => {
  // storage.js holds agent checkpoints: lose the last one to a power cut and a
  // run resumes from an earlier point. That is a fine trade -- but it has to be
  // a recorded choice rather than a default nobody revisited, which is exactly
  // what this whole class of bug was.
  const source = fs.readFileSync(path.join(__dirname, '..', 'storage.js'), 'utf8');
  const index = source.indexOf("applySqliteDurability(this.db, 'RESUMABLE')");
  assert.ok(index > 0, 'storage.js must declare its durability class explicitly');
  assert.match(source.slice(Math.max(0, index - 400), index), /checkpoint/i,
    'storage.js must say why it accepts losing its last write');
});

test('no store sets synchronous inline any more', () => {
  // The setting was one word in four files with the reason recorded in only
  // one, so a chosen value and a defaulted one looked identical. Routing every
  // store through the shared module is what makes the split reviewable.
  const root = path.resolve(__dirname, '..');
  for (const file of ['storage.js', 'lib/memory-store.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/pragma\(\s*['"`]synchronous/.test(source),
      `${file} sets synchronous directly; it should declare a class through lib/sqlite-durability.js`);
  }
});

test('an unknown durability class is refused rather than defaulted', () => {
  // Falling back to a default here would silently downgrade an evidence store.
  const { applySqliteDurability } = require('../lib/sqlite-durability');
  assert.throws(
    () => applySqliteDurability({ pragma() {} }, 'PROBABLY_FINE'),
    /unknown durability class/,
  );
});

/**
 * #2915: the production journal must be EVIDENCE while `storage.db` stays
 * RESUMABLE, in the same process, over the same file. The Epic claims durable
 * fail-closed history; the runtime used to answer it from a RESUMABLE handle,
 * where a commit can return and still be lost on a power cut.
 */
test('the production journal fsyncs while its storage connection does not (#2915)', () => {
  const HuqanStorage = require('../storage');
  const { resolveExperienceJournal } = require('../agentRuntime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-durability-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'memory.db') });
  try {
    const kernel = {};
    const journal = resolveExperienceJournal({ kernel }, storage);
    assert.ok(journal, 'the factory must build the production journal');
    const conn = kernel.experienceJournalConnection;
    assert.ok(conn, 'the factory must expose the journal connection for restore');
    // The class is a property of the handle, so both must hold at once.
    assert.equal(conn.db.pragma('synchronous')[0].synchronous, 2,
      'the journal connection must be EVIDENCE (FULL)');
    assert.equal(storage.db.pragma('synchronous')[0].synchronous, 1,
      'storage.db must stay RESUMABLE (NORMAL): its checkpoints chose that');
    assert.notEqual(conn.db, storage.db, 'they must be separate handles');
    // And an acknowledged append lands on the EVIDENCE handle, not storage.db.
    assert.equal(journal.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' }).ok, true);
    assert.equal(conn.db.prepare('SELECT count(*) AS n FROM experience_journal').get().n, 1);
  } finally {
    try { storage.db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the journal connection refuses an in-memory path instead of forking it (#2915)', () => {
  // A second connection to `:memory:` is a second, empty database, so the
  // journal would look durable while writing nowhere the runtime reads.
  const { openJournalConnection, isSharedableDbPath } = require('../lib/experience/journal-connection');
  assert.equal(isSharedableDbPath(':memory:'), false);
  assert.equal(openJournalConnection({ dbPath: ':memory:' }), null);
  assert.equal(openJournalConnection({}), null);
});
