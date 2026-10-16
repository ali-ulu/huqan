'use strict';

// Production Gate A item 6 (#2366): missing or contradictory startup
// configuration must stop the boot with a specific message, not a raw stack.
//
// CLI and MCP are local-first: unlike the server they need no API key, and a
// keyless boot succeeding is the contract (locked below), not an accident.
// What stops them is contradictory configuration — the same HUQAN_ENV_CONFLICT
// the server refuses — reported with an operator-readable line.
//
// Unit cases exercise the pure validator directly. Boot-path cases spawn the
// real entrypoints and assert the deliberate exit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { assertBootEnvironment, formatBootError } = require('../lib/environment-compat');

const CLI = path.join(__dirname, '..', 'cli.js');
const MCP = path.join(__dirname, '..', 'mcpServer.js');

test('keyless environment passes: CLI/MCP need no API key (local-first)', () => {
  assertBootEnvironment({});
  assertBootEnvironment({ HUQAN_PORT: '3000' });
});

test('conflicting keys throw HUQAN_ENV_CONFLICT instead of a quiet choice', () => {
  assert.throws(
    () => assertBootEnvironment({ HUQAN_LANG: 'a', AXIOM_LANG: 'b' }),
    { code: 'HUQAN_ENV_CONFLICT' },
  );
});

test('boot error line names the runtime, message, and code', () => {
  const error = new Error('conflicting environment variables: HUQAN_LANG and AXIOM_LANG');
  error.code = 'HUQAN_ENV_CONFLICT';
  assert.equal(
    formatBootError('cli', error),
    'HUQAN cli cannot start: conflicting environment variables: HUQAN_LANG and AXIOM_LANG (code=HUQAN_ENV_CONFLICT)',
  );
  assert.match(formatBootError('mcp', error), /^HUQAN mcp cannot start: .* \(code=HUQAN_ENV_CONFLICT\)$/);
});

test('cli boots without an API key and answers --help', () => {
  const env = { ...process.env };
  delete env.HUQAN_API_KEY;
  delete env.AXIOM_API_KEY;
  const child = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `expected clean exit; stderr=${child.stderr}`);
  assert.match(child.stdout, /HUQAN commands/);
});

test('cli boot with conflicting configuration stops with a specific message', () => {
  const env = {
    ...process.env,
    HUQAN_LANG: 'canonical-secret-sentinel',
    AXIOM_LANG: 'legacy-secret-sentinel',
  };
  delete env.HUQAN_API_KEY;
  delete env.AXIOM_API_KEY;
  const child = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0, `expected non-zero exit; output=${output}`);
  assert.match(output, /HUQAN cli cannot start/, `specific message missing; output=${output}`);
  assert.match(output, /HUQAN_ENV_CONFLICT/, `error code missing; output=${output}`);
  assert.doesNotMatch(output, /HUQAN commands/, 'half-started CLI must not print help');
  assert.equal(output.includes('canonical-secret-sentinel'), false);
  assert.equal(output.includes('legacy-secret-sentinel'), false);
});

test('mcp boot with conflicting configuration stops with a specific message', () => {
  const env = {
    ...process.env,
    HUQAN_LANG: 'canonical-secret-sentinel',
    AXIOM_LANG: 'legacy-secret-sentinel',
  };
  delete env.HUQAN_API_KEY;
  delete env.AXIOM_API_KEY;
  const child = spawnSync(process.execPath, [MCP], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0, `expected non-zero exit; output=${output}`);
  assert.match(output, /HUQAN mcp cannot start/, `specific message missing; output=${output}`);
  assert.match(output, /HUQAN_ENV_CONFLICT/, `error code missing; output=${output}`);
  assert.equal(output.includes('canonical-secret-sentinel'), false);
  assert.equal(output.includes('legacy-secret-sentinel'), false);
});
