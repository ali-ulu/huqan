'use strict';

// Direct tests for the individual doctor checks. test/cli-doctor.test.js covers
// the aggregation and the CLI surface with stubbed checkers; this file drives
// the real checkers against throwaway workspaces so each failure branch is
// observed, not assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CHECK_ORDER,
  checkConfig,
  checkFilesystem,
  checkMcp,
  checkMigrations,
  checkRust,
  checkSchema,
  checkSqlite,
  formatDoctorResult,
  probeJsonLines,
  runDoctorChecks,
} = require('../lib/cli-doctor');
const { resolvePersistencePaths } = require('../persistencePaths');
const { applyStorageSchema, ADDITIVE_COLUMNS, SCHEMA_INDEXES } = require('../lib/storage/schema');
const { loadSqliteDriver } = require('../lib/sqlite-availability');

const REPO_ROOT = path.join(__dirname, '..');
const { Database } = loadSqliteDriver();
const PATH_ENV = ['HUQAN_DB_PATH', 'AXIOM_DB_PATH', 'HUQAN_MEMORY_PATH', 'AXIOM_MEMORY_PATH'];

// The doctor resolves the database from the environment first; a developer
// shell with HUQAN_DB_PATH set must not point these tests at a real store.
const savedEnv = {};
test.before(() => {
  for (const name of PATH_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});
test.after(() => {
  for (const name of PATH_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createStore(root, mutate) {
  const { dbPath } = resolvePersistencePaths({ rootDir: root });
  const db = new Database(dbPath);
  try {
    applyStorageSchema(db);
    if (mutate) mutate(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function writeMigration(root, name, sql) {
  fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'migrations', name), sql);
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.killed = false;
  child.stdin = { write: (line) => child.written.push(line), end: () => {} };
  child.kill = () => { child.killed = true; };
  return child;
}

// ─── SQLite, schema, migrations ─────────────────────────────────────────────

test('sqlite check passes on a healthy store and names the database file', (t) => {
  const root = workspace(t);
  const dbPath = createStore(root);
  const result = checkSqlite({ rootDir: root });
  assert.equal(result.ok, true);
  assert.equal(result.detail, path.basename(dbPath));
});

test('sqlite check throws when there is no store to open', (t) => {
  const root = workspace(t);
  assert.throws(() => checkSqlite({ rootDir: root }));
});

test('schema check reports a missing index', (t) => {
  const root = workspace(t);
  const index = /INDEX IF NOT EXISTS\s+([A-Za-z0-9_]+)/i.exec(SCHEMA_INDEXES[0])[1];
  createStore(root, (db) => db.exec(`DROP INDEX ${index}`));
  const result = checkSchema({ rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingIndexes, [index]);
  assert.match(result.detail, new RegExp(`missing indexes: ${index}`));
});

test('schema and migrations checks report a pending additive column', (t) => {
  const root = workspace(t);
  const pending = ADDITIVE_COLUMNS.find((migration) => !SCHEMA_INDEXES.some((sql) => sql.includes(migration.column)));
  createStore(root, (db) => db.exec(`ALTER TABLE ${pending.table} DROP COLUMN ${pending.column}`));
  writeMigration(root, 'noop.sql', '-- nothing declared\n');
  const name = `${pending.table}.${pending.column}`;

  const schema = checkSchema({ rootDir: root });
  assert.equal(schema.ok, false);
  assert.deepEqual(schema.pendingColumns, [name]);
  assert.match(schema.detail, new RegExp(`pending columns: ${name}`));

  const migrations = checkMigrations({ rootDir: root });
  assert.equal(migrations.ok, false);
  assert.deepEqual(migrations.pending, [name]);
  assert.equal(migrations.applied, ADDITIVE_COLUMNS.length - 1);
  assert.match(migrations.detail, new RegExp(`pending: ${name}`));
});

test('schema check passes on a fully migrated store', (t) => {
  const root = workspace(t);
  createStore(root);
  const result = checkSchema({ rootDir: root });
  assert.equal(result.ok, true);
  assert.match(result.detail, new RegExp(`${ADDITIVE_COLUMNS.length} migrations applied`));
});

test('migrations check fails when migrations/ has no SQL artifact', (t) => {
  const root = workspace(t);
  createStore(root);
  const result = checkMigrations({ rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.migrationFiles, []);
  assert.match(result.detail, /migrations\/ has no \.sql files/);
});

test('migrations check names an object a migration declares but the store lacks', (t) => {
  // Regression: the declaration regexes used a doubled backslash (`\\s+`), so
  // they never matched real SQL and this check could not fire.
  const root = workspace(t);
  createStore(root);
  writeMigration(root, '001-ghost.sql', 'CREATE TABLE IF NOT EXISTS ghost_table (id TEXT);\n'
    + 'CREATE INDEX IF NOT EXISTS idx_ghost ON ghost_table (id);\n');
  const result = checkMigrations({ rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingMigrationObjects, ['001-ghost.sql:ghost_table', '001-ghost.sql:idx_ghost']);
  assert.match(result.detail, /missing migration objects: 001-ghost\.sql:ghost_table/);
});

test('migrations check sees UNIQUE indexes and ignores a schema qualifier', (t) => {
  const root = workspace(t);
  createStore(root, (db) => db.exec('CREATE TABLE qualified_present (id TEXT)'));
  writeMigration(root, '002-forms.sql', 'CREATE TABLE IF NOT EXISTS main.qualified_present (id TEXT);\n'
    + 'CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_absent ON qualified_present (id);\n');
  const result = checkMigrations({ rootDir: root });
  assert.deepEqual(result.missingMigrationObjects, ['002-forms.sql:idx_unique_absent'],
    'the qualified table exists under its bare name; the missing UNIQUE index must be named');
});

test('migrations check passes against the migrations the package ships', (t) => {
  const root = workspace(t);
  createStore(root);
  fs.cpSync(path.join(REPO_ROOT, 'migrations'), path.join(root, 'migrations'), { recursive: true });
  const result = checkMigrations({ rootDir: root });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.applied, ADDITIVE_COLUMNS.length);
});

// ─── the JSON-lines health probe ────────────────────────────────────────────

test('probe collects one response per request and skips blank and non-JSON lines', async () => {
  const child = fakeChild();
  const pending = probeJsonLines('cmd', [], [{ id: 1 }, { id: 2 }], { spawnImpl: () => child, timeoutMs: 1000 });
  child.stdout.emit('data', Buffer.from('\nnot json\n{"id":1}\n{"id"'));
  child.stdout.emit('data', Buffer.from(':2}\n'));
  const { responses } = await pending;
  assert.deepEqual(responses, [{ id: 1 }, { id: 2 }]);
  assert.equal(child.written.length, 2);
  assert.equal(child.killed, true);
});

test('probe rejects when the child exits before answering, carrying its stderr', async () => {
  const child = fakeChild();
  const pending = probeJsonLines('cmd', [], [{ id: 1 }], { spawnImpl: () => child, timeoutMs: 1000 });
  child.stderr.emit('data', Buffer.from('boom\n'));
  child.emit('exit', 3, null);
  await assert.rejects(pending, /exited early \(code=3, signal=none\): boom/);
});

test('probe rejects with a typed timeout when nothing answers', async () => {
  const child = fakeChild();
  await assert.rejects(
    probeJsonLines('cmd', [], [{ id: 1 }], { spawnImpl: () => child, timeoutMs: 20 }),
    (error) => error.code === 'DOCTOR_PROBE_TIMEOUT',
  );
});

test('probe rejects on a spawn that throws and on a child error event', async () => {
  await assert.rejects(
    probeJsonLines('cmd', [], [{ id: 1 }], { spawnImpl: () => { throw new Error('ENOENT'); } }),
    /ENOENT/,
  );
  const child = fakeChild();
  const pending = probeJsonLines('cmd', [], [{ id: 1 }], { spawnImpl: () => child, timeoutMs: 1000 });
  child.emit('error', new Error('spawn failed'));
  child.emit('error', new Error('second error is ignored once settled'));
  await assert.rejects(pending, /spawn failed/);
});

// ─── Rust and MCP probes ────────────────────────────────────────────────────

function answering(lines) {
  return () => {
    const child = fakeChild();
    setImmediate(() => child.stdout.emit('data', Buffer.from(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)));
    return child;
  };
}

test('rust check reports the crate version on a healthy stats answer', async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'huqan-core'));
  fs.writeFileSync(path.join(root, 'huqan-core', 'Cargo.toml'), '[package]\nversion = "9.8.7"\n');
  const result = await checkRust({
    rootDir: root,
    environment: { HUQAN_RUST_BIN: process.execPath },
    spawnImpl: answering([{ _reqId: 1, ok: true, stats: { nodes: 0 } }]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'v9.8.7');
});

test('rust check falls back to the binary name without a crate, and fails on a bad answer', async (t) => {
  const root = workspace(t);
  const env = { HUQAN_RUST_BIN: process.execPath };
  const unversioned = await checkRust({ rootDir: root, environment: env, spawnImpl: answering([{ ok: true, stats: {} }]) });
  assert.equal(unversioned.ok, true);
  assert.equal(unversioned.detail, path.basename(process.execPath));
  assert.equal(unversioned.version, null);

  const failed = await checkRust({ rootDir: root, environment: env, spawnImpl: answering([{ _reqId: 1, ok: false }]) });
  assert.equal(failed.ok, false);
  assert.equal(failed.detail, 'stats health check failed');
});

test('mcp check counts tools on a healthy server and fails on a broken handshake', async () => {
  const healthy = await checkMcp({
    rootDir: REPO_ROOT,
    spawnImpl: answering([
      { id: 1, result: { serverInfo: { name: 'huqan', version: 'x' } } },
      { id: 2, result: { tools: [{}, {}, {}] } },
    ]),
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.detail, '3 tools');
  assert.equal(healthy.toolCount, 3);

  const broken = await checkMcp({
    rootDir: REPO_ROOT,
    spawnImpl: answering([{ id: 1, result: {} }, { id: 2, error: { code: -1 } }]),
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.detail, 'initialize/tools/list failed');
  assert.equal(broken.server, null);
  assert.equal(broken.toolCount, 0);
});

// ─── filesystem and config ──────────────────────────────────────────────────

test('filesystem check names the receipts directory it cannot write', (t) => {
  const root = workspace(t);
  const blocker = path.join(root, 'state-is-a-file');
  fs.writeFileSync(blocker, '');
  const result = checkFilesystem({ rootDir: root, environment: { HUQAN_STATE_ROOT: blocker } });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'receipts dir not writable');

  const healthy = checkFilesystem({ rootDir: root, environment: { HUQAN_STATE_ROOT: path.join(root, 'state') } });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.detail, root);
});

test('config check accepts the shipped trust policy and rejects a malformed one', (t) => {
  const shipped = checkConfig({ rootDir: REPO_ROOT, environment: {} });
  assert.equal(shipped.ok, true);
  assert.match(shipped.detail, /^v/);

  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'trust-policy.default.json'), JSON.stringify({ defaults: {} }));
  const malformed = checkConfig({ rootDir: root, environment: {} });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.detail, 'invalid trust-policy.default.json shape');
  assert.equal(malformed.version, null);
});

// ─── report shape ───────────────────────────────────────────────────────────

test('a thrown non-Error and a missing check still produce a readable report', async () => {
  const checkers = Object.fromEntries(CHECK_ORDER.map(([key]) => [key, () => ({ ok: true })]));
  checkers.config = () => { throw 'plain   string\nfailure'; }; // eslint-disable-line no-throw-literal
  const result = await runDoctorChecks({}, { checkers });
  assert.equal(result.checks.config.ok, false);
  assert.equal(result.checks.config.detail, 'plain string failure');
  assert.equal(result.checks.config.error, 'CHECK_FAILED');

  const text = formatDoctorResult({ checks: { sqlite: { ok: true } } });
  const lines = text.split('\n');
  assert.equal(lines.length, CHECK_ORDER.length);
  assert.match(lines[0], /^SQLite\s+OK$/);
  assert.match(lines[1], /^Schema\s+FAIL \(not run\)$/);
});
