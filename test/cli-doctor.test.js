'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageManifest = require('../package.json');

const { parseCommand } = require('../lib/command-parser');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const {
  CHECK_ORDER,
  formatDoctorResult,
  runDoctorChecks,
} = require('../lib/cli-doctor');
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

test('doctor text output keeps the operator-readable seven-line shape', () => {
  const checks = {};
  for (const [key, name] of CHECK_ORDER) checks[key] = { name, ok: true, detail: key };
  const text = formatDoctorResult({ ok: true, checks });

  assert.equal(text.split('\n').length, 7);
  assert.match(text, /^SQLite\s+OK \(sqlite\)$/m);
  assert.match(text, /^Rust accelerator\s+OK \(rust\)$/m);
  assert.match(text, /^Config\s+OK \(config\)$/m);
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
