'use strict';

// The receiver authority decides which keys are trusted, so its reader refuses
// anything but a plain, bounded file (#2185 moved it to its own module).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readReceiverAuthority } = require('../lib/a2a/exchange-route-authority');
const { MAX_BODY_BYTES } = require('../lib/a2a/exchange-route-contract');

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-authority-'));
  try { return fn(fs.realpathSync(dir)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a bounded authority file is read and parsed', () => withDir((dir) => {
  const file = path.join(dir, 'authority.json');
  fs.writeFileSync(file, JSON.stringify({ evaluationTime: 'x' }));
  assert.deepEqual(readReceiverAuthority(file), { evaluationTime: 'x' });
}));

test('an empty or oversized authority file is refused as unsafe', () => withDir((dir) => {
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '');
  assert.throws(() => readReceiverAuthority(empty), /receiver authority path is unsafe/);

  const oversized = path.join(dir, 'oversized.json');
  fs.writeFileSync(oversized, `"${'a'.repeat(MAX_BODY_BYTES)}"`);
  assert.throws(() => readReceiverAuthority(oversized), /receiver authority path is unsafe/);
}));

test('a relative authority path is refused', () => {
  assert.throws(() => readReceiverAuthority('authority.json'), /absolute receiver authority required/);
});
