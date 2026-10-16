const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const Graph = require('../graph');
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  resolveBusyTimeoutMs,
  sqlitePragmaSql,
} = require('../lib/graph-sqlite-pragmas');

test('the pragma preamble keeps WAL and full durability alongside the busy timeout', () => {
  const sql = sqlitePragmaSql();
  assert.match(sql, /PRAGMA journal_mode = WAL;/);
  // #1432: the graph is canonical, so durability stays FULL.
  assert.match(sql, /PRAGMA synchronous = FULL;/);
  assert.match(sql, new RegExp(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`));
});

test('a caller-supplied busy timeout is honoured, and nonsense falls back to the default', () => {
  assert.match(sqlitePragmaSql({ busyTimeoutMs: 250 }), /PRAGMA busy_timeout = 250;/);
  assert.strictEqual(resolveBusyTimeoutMs(0), 0);
  assert.strictEqual(resolveBusyTimeoutMs(-1), DEFAULT_BUSY_TIMEOUT_MS);
  assert.strictEqual(resolveBusyTimeoutMs('nope'), DEFAULT_BUSY_TIMEOUT_MS);
  assert.strictEqual(resolveBusyTimeoutMs(undefined), DEFAULT_BUSY_TIMEOUT_MS);
});

test('an opened SQLite graph actually carries the pragmas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-pragmas-'));
  const graph = new Graph({ useSQLite: true, dbPath: path.join(dir, 'graph.db') });
  assert.strictEqual(graph._db.pragma('journal_mode', { simple: true }), 'wal');
  // SQLite reports `synchronous` numerically: 2 is FULL.
  assert.strictEqual(graph._db.pragma('synchronous', { simple: true }), 2);
  assert.strictEqual(graph._db.pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);
});

test('a graph can be opened with a tuned busy timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-pragmas-tuned-'));
  const graph = new Graph({ useSQLite: true, dbPath: path.join(dir, 'graph.db'), busyTimeoutMs: 250 });
  assert.strictEqual(graph._db.pragma('busy_timeout', { simple: true }), 250);
});

test('an unusable busy timeout falls back to the default rather than opening unguarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-pragmas-junk-'));
  const graph = new Graph({ useSQLite: true, dbPath: path.join(dir, 'graph.db'), busyTimeoutMs: 'nope' });
  assert.strictEqual(graph._db.pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS);
});
