'use strict';

// #3419: the installed-package guard probes parsed child JSON with
// `try { JSON.parse(x) } catch (_) {}`, so a malformed stream left the value
// null and the verdict said only "did not fail closed". The parse error is
// now surfaced with the process that produced it, so a red build names the
// broken stream instead of hiding it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonOutput } = require('../scripts/verify-tarball-checks-guard');

test('parseJsonOutput returns the parsed value for a valid stream', () => {
  const parsed = parseJsonOutput({ stdout: '{"decision":"block"}' }, 'guard');
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.value, { decision: 'block' });
});

test('parseJsonOutput names the failing process and the parse error', () => {
  const parsed = parseJsonOutput({ stdout: 'not json' }, 'installed huqan-gate install');
  assert.equal(parsed.value, null);
  assert.match(parsed.error, /installed huqan-gate install stdout is not JSON/);
  assert.match(parsed.error, /Unexpected token/);
});

test('parseJsonOutput does not swallow an empty stream', () => {
  const parsed = parseJsonOutput({ stdout: '' }, 'installed huqan-gate status');
  assert.equal(parsed.value, null);
  assert.match(parsed.error, /installed huqan-gate status stdout is not JSON/);
});
