'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { spawnSyncWindowsAware } = require('../scripts/spawn-windows-aware');

const onWindows = process.platform === 'win32';

test('a .cmd shim runs, where a direct spawn refuses to start it', { skip: !onWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cmd-spawn-'));
  try {
    const script = path.join(dir, 'hello.cmd');
    fs.writeFileSync(script, '@echo off\r\necho hi\r\n');

    // The failure this exists to prevent, asserted rather than described: Node
    // will not launch a .cmd directly, and the refusal arrives as a null status
    // with an empty stderr -- which is why it read as a crashed child for so
    // long in the 4C1 MCP smoke.
    const direct = cp.spawnSync(script, [], { encoding: 'utf8' });
    assert.equal(direct.status, null);
    assert.equal(direct.error && direct.error.code, 'EINVAL');

    const shimmed = spawnSyncWindowsAware(script, [], { encoding: 'utf8' });
    assert.equal(shimmed.status, 0, `stderr: ${shimmed.stderr}`);
    assert.equal(String(shimmed.stdout).trim(), 'hi');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('arguments reach a .cmd unmangled', { skip: !onWindows }, () => {
  // Passed as their own argv entries rather than interpolated into a command
  // line, so a value with a space is one argument, not two.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cmd-args-'));
  try {
    const script = path.join(dir, 'echo-args.cmd');
    fs.writeFileSync(script, '@echo off\r\necho [%~1]\r\n');
    const result = spawnSyncWindowsAware(script, ['two words'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(String(result.stdout).trim(), '[two words]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-.cmd target is spawned directly', () => {
  const result = spawnSyncWindowsAware(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
});

test('stdin still reaches the child through the shim', () => {
  // The 4C1 smoke drives the MCP server by writing JSON-RPC to stdin, so a shim
  // that dropped `input` would turn a passing test into a silent hang.
  const result = spawnSyncWindowsAware(
    process.execPath,
    ['-e', 'process.stdin.on("data", d => process.stdout.write(d))'],
    { input: 'echoed', encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'echoed');
});

test('every launcher of an installed bin goes through the shim', () => {
  // The bug was not the missing workaround, it was that the workaround was
  // copied into two scripts and therefore absent from the third caller. This
  // fails if a fourth site open-codes it again.
  const root = path.resolve(__dirname, '..');
  const sites = [
    'scripts/verify-package-tarball.js',
    'scripts/launch-installed-package-smoke.js',
    'test/kernel-facade-contract.test.js',
  ];
  for (const site of sites) {
    const text = fs.readFileSync(path.join(root, site), 'utf8');
    assert.ok(text.includes('spawnSyncWindowsAware'), `${site} must use the shared shim`);
    assert.ok(!/ComSpec/.test(text), `${site} re-implements the shim instead of requiring it`);
  }
});
