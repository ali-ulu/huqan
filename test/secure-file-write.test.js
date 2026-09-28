'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  atomicCopyFileSync,
  atomicWriteFileSync,
  probeWritablePathSync,
} = require('../lib/secure-file-write');

function scratch(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('secure atomic write replaces through a private sibling and leaves no staging file', (t) => {
  const directory = scratch(t, 'huqan-secure-write-');
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, 'old', { mode: 0o600 });

  atomicWriteFileSync(target, 'new');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.statSync(target).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('secure atomic copy replaces through a private sibling and leaves no staging file', (t) => {
  const directory = scratch(t, 'huqan-secure-copy-');
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  fs.writeFileSync(source, 'payload', { mode: 0o600 });

  atomicCopyFileSync(source, target);

  assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
  assert.equal(fs.statSync(target).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['source', 'target']);
});

test('writability probe creates a private exclusive file and removes it', (t) => {
  const directory = scratch(t, 'huqan-secure-probe-');
  const nested = path.join(directory, 'nested');

  assert.equal(probeWritablePathSync(path.join(nested, 'state.json')), true);
  assert.deepEqual(fs.readdirSync(nested), []);
});
