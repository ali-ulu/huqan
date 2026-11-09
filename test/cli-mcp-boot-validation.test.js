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
const fs = require('node:fs');
const os = require('node:os');

const { assertBootEnvironment, formatBootError, reportBootError } = require('../lib/environment-compat');

const CLI = path.join(__dirname, '..', 'cli.js');
const MCP = path.join(__dirname, '..', 'mcpServer.js');
const SERVER = path.join(__dirname, '..', 'server.js');

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

// #4557: the server shares the cli/mcp boot-failure contract. Its kernel and
// store open at module load, so a boot failure used to dump a raw Node stack.
// The entrypoint must print the same readable line and fail closed.
test('server boot with an unsupported kernel selector stops with a readable line', () => {
  const env = {
    ...process.env,
    HUQAN_KERNEL_VERSION: 'not-a-real-kernel',
    HUQAN_DISABLE_AUTO_LISTEN: '1',
  };
  const child = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1, `expected a fail-closed exit; output=${output}`);
  assert.match(output, /HUQAN server cannot start/, `readable line missing; output=${output}`);
  assert.match(output, /HUQAN_KERNEL_VERSION_UNSUPPORTED/, `error code missing; output=${output}`);
  assert.doesNotMatch(output, /^\s+at /m, 'boot failure must not dump a raw stack');
});

test('server boot with conflicting configuration stops with a specific message', () => {
  const env = {
    ...process.env,
    HUQAN_LANG: 'canonical-secret-sentinel',
    AXIOM_LANG: 'legacy-secret-sentinel',
    HUQAN_DISABLE_AUTO_LISTEN: '1',
  };
  const child = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1, `expected a fail-closed exit; output=${output}`);
  assert.match(output, /HUQAN server cannot start/, `specific message missing; output=${output}`);
  assert.match(output, /HUQAN_ENV_CONFLICT/, `error code missing; output=${output}`);
  assert.doesNotMatch(output, /^\s+at /m, 'boot failure must not dump a raw stack');
  assert.equal(output.includes('canonical-secret-sentinel'), false);
  assert.equal(output.includes('legacy-secret-sentinel'), false);
});

// #4557: the boot wrapper prints the readable line and exits only for the
// direct entrypoint; an embedding consumer (require.main !== module) still gets
// the throw so it can handle the failure itself. Both arms are pinned so the
// wrapper cannot start swallowing a boot error for an in-process caller.
test('server boot error rethrows for an in-process consumer instead of exiting', () => {
  const env = { ...process.env, HUQAN_KERNEL_VERSION: 'not-a-real-kernel' };
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SERVER)})`], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0, `expected a non-zero exit; output=${output}`);
  assert.match(output, /HUQAN_KERNEL_VERSION_UNSUPPORTED/, `the in-process caller must see the error; output=${output}`);
});

// #4557: the environment-driven limits are validated before the store opens,
// so a bad value fails closed with the readable line instead of a raw stack
// after the graph already opened its SQLite handle. Isolated --db-path and
// --memory-path prove nothing was created on disk.
test('server boot validates request limits before opening the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-boot-limit-'));
  try {
    const dbPath = path.join(dir, 'graph.sqlite');
    const memoryPath = path.join(dir, 'memory.json');
    const env = {
      ...process.env,
      HUQAN_MAX_CONCURRENT_REQUESTS: '0',
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_DB_PATH: dbPath,
      HUQAN_MEMORY_PATH: memoryPath,
    };
    const child = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 60_000 });
    const output = `${child.stdout}${child.stderr}`;
    assert.equal(child.status, 1, `expected a fail-closed exit; output=${output}`);
    assert.match(output, /HUQAN server cannot start/, `readable line missing; output=${output}`);
    assert.match(output, /HUQAN_REQUEST_LIMIT_INVALID/, `error code missing; output=${output}`);
    assert.doesNotMatch(output, /^\s+at /m, 'boot failure must not dump a raw stack');
    assert.equal(fs.existsSync(dbPath), false, 'the store must not be created before validation');
    assert.equal(fs.existsSync(memoryPath), false, 'the memory store must not be created before validation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server env conflict rethrows for an in-process consumer instead of exiting', () => {
  const env = { ...process.env, HUQAN_LANG: 'canonical-secret-sentinel', AXIOM_LANG: 'legacy-secret-sentinel' };
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SERVER)})`], { env, encoding: 'utf8', timeout: 60_000 });
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0, `expected a non-zero exit; output=${output}`);
  assert.match(output, /HUQAN_ENV_CONFLICT/, `the in-process caller must see the error; output=${output}`);
});

// #4557: a pipe can accept only part of a long write, so reportBootError must
// loop until the whole line is out. Stub fs.writeSync to hand back three bytes
// at a time and assert the reassembled output is the complete line.
test('reportBootError writes the whole line across partial writes', () => {
  const realWriteSync = fs.writeSync;
  const chunks = [];
  fs.writeSync = (fd, buffer, offset) => {
    const size = Math.min(3, buffer.length - offset);
    chunks.push(buffer.slice(offset, offset + size));
    return size;
  };
  try {
    reportBootError('server', Object.assign(new Error('partial'), { code: 'HUQAN_PARTIAL' }));
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.equal(chunks.join(''), 'HUQAN server cannot start: partial (code=HUQAN_PARTIAL)\n');
});

// #4557: the diagnostic must survive the fail-closed exit. console.error() only
// queues on a POSIX pipe, so a long line was cut to the 64 KiB pipe buffer
// before process.exit(1) drained it. reportBootError now writes fd 2
// synchronously; this spawns a child that exits right after a 200k line and
// asserts the whole line -- including the trailing (code=...) -- arrives.
test('boot diagnostic survives the fail-closed exit even when stderr is a pipe', () => {
  const script = `const { reportBootError } = require(${JSON.stringify(require.resolve('../lib/environment-compat'))});
const error = new Error('m'.repeat(200000));
error.code = 'HUQAN_KERNEL_VERSION_UNSUPPORTED';
reportBootError('server', error);
process.exit(1);`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1, `expected the fail-closed exit; output=${output.slice(0, 200)}`);
  // Compare the complete line: a regex like /m+ \(code=...\)/ would still pass
  // on a truncated body, which is exactly the failure this guards against.
  const expected = `HUQAN server cannot start: ${'m'.repeat(200000)} (code=HUQAN_KERNEL_VERSION_UNSUPPORTED)\n`;
  assert.equal(output, expected, `the full diagnostic must reach the pipe; got ${output.length} of ${expected.length} bytes`);
});

// The synchronous write is the point: on a closed fd 2 (or an unavailable
// stream) it must degrade to process.stderr.write instead of throwing, so the
// fail-closed exit still reports. The child closes fd 2, reports, and must exit
// cleanly rather than surface an EBADF.
test('boot diagnostic does not throw when stderr is closed', () => {
  const script = `const fs = require('node:fs');
const { reportBootError } = require(${JSON.stringify(require.resolve('../lib/environment-compat'))});
fs.closeSync(2);
reportBootError('server', new Error('boom'));
process.stdout.write('reported');`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `expected a clean exit; stderr=${child.stderr}`);
  assert.match(child.stdout, /reported/, 'reportBootError must not throw when fd 2 is closed');
});


