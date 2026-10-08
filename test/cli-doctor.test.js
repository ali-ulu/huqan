'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageManifest = require('../package.json');

const { parseCommand } = require('../lib/command-parser');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const {
  CHECK_ORDER,
  checkMigrations,
  checkSchema,
  checkSqlite,
  formatDoctorResult,
  runDoctorChecks,
} = require('../lib/cli-doctor');
const { resolvePersistencePaths } = require('../persistencePaths');
const { applyStorageSchema } = require('../lib/storage/schema');
const { loadSqliteDriver } = require('../lib/sqlite-availability');
const {
  ADDITIVE_COLUMNS,
  STORAGE_SCHEMA_VERSION,
} = require('../lib/storage/schema');

function passingCheckers(overrides = {}) {
  return Object.fromEntries(CHECK_ORDER.map(([key]) => [
    key,
    overrides[key] || (() => ({ ok: true, detail: key })),
  ]));
}

test('doctor migration artifacts are shipped in the npm package', () => {
  assert.equal(packageManifest.files.includes('migrations'), true);
});

// #3703: every other test here mocks the checkers or the CLI, so the real
// fresh-store path was never exercised -- and it was broken. A first `doctor`
// with `HUQAN_DB_PATH` naming a brand-new graph file reported Schema/Migrations
// FAIL because the checks inspected that graph file (which the storage schema
// does not touch on the CLI path) instead of the storage store beside it.
// This drives the real checkers against a real store on the fresh-env path.
test('doctor inspects the storage store, not the HUQAN_DB_PATH graph file (#3703)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-doctor-fresh-'));
  const graphPath = path.join(dir, 'graph.db');
  const previous = process.env.HUQAN_DB_PATH;
  process.env.HUQAN_DB_PATH = graphPath;
  try {
    const { memoryPath } = resolvePersistencePaths({ rootDir: dir });
    const storagePath = memoryPath.replace(/\.json$/i, '.db');
    // What the CLI's own boot does before `doctor` runs: the storage schema is
    // applied to the memory store's `.db` sibling, not to the graph file.
    const { Database } = loadSqliteDriver();
    const db = new Database(storagePath);
    applyStorageSchema(db);
    db.close();
    assert.equal(fs.existsSync(graphPath), false, 'the graph file is not the storage store');

    assert.equal(checkSqlite({ rootDir: dir }).detail, path.basename(storagePath));

    const schema = checkSchema({ rootDir: dir });
    assert.equal(schema.ok, true, `checkSchema reported: ${schema.detail}`);
    assert.equal(schema.missingTables.length, 0);
    assert.equal(schema.pendingColumns.length, 0);

    const migrations = checkMigrations({ rootDir: dir });
    assert.equal(migrations.ok, true, `checkMigrations reported: ${migrations.detail}`);
    assert.equal(migrations.pending.length, 0);
    assert.deepEqual(migrations.missingMigrationObjects, []);
  } finally {
    if (previous === undefined) delete process.env.HUQAN_DB_PATH;
    else process.env.HUQAN_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage schema version tracks the additive migration registry', () => {
  assert.equal(STORAGE_SCHEMA_VERSION, ADDITIVE_COLUMNS.length);
});

test('doctor is a parsed CLI command with the system status workflow contract', () => {
  const parsed = parseCommand('doctor');
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.args, '');
  assert.equal(parsed.workflowId, 'system-status');
});

test('doctor aggregates all checks and fails closed when any one fails', async () => {
  const result = await runDoctorChecks({}, {
    checkers: passingCheckers({
      rust: () => ({ ok: false, detail: 'binary missing' }),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.sqlite.ok, true);
  assert.equal(result.checks.rust.ok, false);
  assert.equal(result.checks.rust.detail, 'binary missing');
  assert.equal(Object.keys(result.checks).length, CHECK_ORDER.length);
});

test('doctor turns checker exceptions into bounded failures instead of aborting the report', async () => {
  const result = await runDoctorChecks({}, {
    checkers: passingCheckers({
      mcp: () => {
        const error = new Error('mcp unavailable');
        error.code = 'MCP_DOWN';
        throw error;
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.mcp.ok, false);
  assert.equal(result.checks.mcp.error, 'MCP_DOWN');
  assert.equal(result.checks.config.ok, true);
});

test('doctor text output keeps the operator-readable nine-line shape', () => {
  const checks = {};
  for (const [key, name] of CHECK_ORDER) checks[key] = { name, ok: true, detail: key };
  const text = formatDoctorResult({ ok: true, checks });

  assert.equal(text.split('\n').length, 9);
  assert.match(text, /^SQLite\s+OK \(sqlite\)$/m);
  assert.match(text, /^Rust accelerator\s+OK \(rust\)$/m);
  assert.match(text, /^Config\s+OK \(config\)$/m);
  assert.match(text, /^Security\s+OK \(security\)$/m);
  assert.match(text, /^Egress\s+OK \(egress\)$/m);
});

test('CLI doctor --json emits raw doctor JSON and exits 1 on any failed check', async () => {
  const stdout = [];
  const cli = {
    parse: () => ({ command: 'doctor', args: '', workflowId: 'system-status' }),
    evaluateCliGate: () => null,
    execute: async () => ({
      ok: false,
      checks: { sqlite: { name: 'SQLite', ok: false, detail: 'integrity_check failed' } },
      text: 'SQLite          FAIL (integrity_check failed)',
    }),
  };

  const result = await runCliArgv(['doctor', '--json'], {
    cli,
    stdout: (value) => stdout.push(value),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(stdout[0]).ok, false);
  assert.equal(JSON.parse(stdout[0]).checks.sqlite.ok, false);
});

test('CLI doctor plain output exits 0 only when every check passes', async () => {
  const stdout = [];
  const cli = {
    parse: () => ({ command: 'doctor', args: '', workflowId: 'system-status' }),
    evaluateCliGate: () => null,
    execute: async () => ({
      ok: true,
      checks: {},
      text: 'SQLite          OK',
    }),
  };

  const result = await runCliArgv(['doctor'], {
    cli,
    stdout: (value) => stdout.push(value),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stdout[0], 'SQLite          OK');
});
