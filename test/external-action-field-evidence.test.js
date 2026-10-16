'use strict';

/**
 * #3618 (R53): field-level evidence on a gate decision.
 *
 * A gate verdict names the rule that fired but not the field it measured or
 * what the value was. `externalActionFieldEvidence` turns the bounded signals
 * the envelope already carries into `{propertyPath, valueBefore, valueAfter}`
 * rows, and names the firewall's 512-char clip as length before/after. It is
 * pure and reads only the redacted envelope, so no raw caller value enters a
 * row, and it is bounded so a decision cannot carry an unbounded proof.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExternalActionEnvelope,
  externalActionFieldEvidence,
} = require('../lib/external-action-envelope');

function envelope(overrides = {}, options = {}) {
  return normalizeExternalActionEnvelope({
    invocationId: 'inv-field-1',
    workspaceId: 'default',
    agent: { name: 'codex', version: '1' },
    action: { kind: 'shell', command: 'git status' },
    ...overrides,
  }, options);
}

test('non-object input yields no evidence, so read paths stay unchanged', () => {
  for (const value of [null, undefined, 'x', 7, ['a'], true]) {
    assert.deepEqual(externalActionFieldEvidence(value), [], String(value));
  }
});

test('the caller input key list is named as a value-free args row', () => {
  const env = envelope({ metadata: { inputKeys: ['command', 'target'] } });
  const rows = externalActionFieldEvidence(env);
  assert.deepEqual(rows[0], { propertyPath: 'args', valueBefore: 'command,target', valueAfter: 'command,target' });
});

test('an allowlisted command names the matched entry, never the caller command', () => {
  const env = envelope(
    { action: { kind: 'shell', command: 'my-custom-tool --check' }, args: { command: 'my-custom-tool --check' } },
    { allowedCommands: ['my-custom-tool'] },
  );
  const row = externalActionFieldEvidence(env).find(entry => entry.propertyPath === 'command.allowlist');
  assert.deepEqual(row, { propertyPath: 'command.allowlist', valueBefore: '', valueAfter: 'my-custom-tool' });
});

test('a resolved target names the relative path against the pinned absolute one', () => {
  const env = envelope({ targetPath: 'sub/file.txt' });
  const row = externalActionFieldEvidence(env).find(entry => entry.propertyPath === 'target.path');
  assert.equal(row.valueBefore, 'sub/file.txt');
  assert.match(row.valueAfter, /sub[\\/]file\.txt$/);
  assert.notEqual(row.valueBefore, row.valueAfter, 'the resolved path differs from the relative one');
});

test('a shell command whose shape differs names the command reduced to its shape', () => {
  const env = envelope({ action: { kind: 'shell', command: 'git status --short' }, args: { command: 'git status --short' } });
  const row = externalActionFieldEvidence(env).find(entry => entry.propertyPath === 'command');
  assert.deepEqual(row, { propertyPath: 'command', valueBefore: 'git status --short', valueAfter: 'git status' });
});

test('a plain shell command with no shaping carries no rows', () => {
  const env = envelope({ action: { kind: 'shell', command: 'git status' }, args: { command: 'git status' } });
  assert.deepEqual(externalActionFieldEvidence(env), []);
});

test('the 200-byte cap counts UTF-8 bytes, not UTF-16 code units, and never splits a character', () => {
  // 200 CJK characters are 600 UTF-8 bytes but only 200 code units; a
  // code-unit check would let the row through at three times the budget.
  const cjk = '好'.repeat(200);
  const env = envelope({ metadata: { inputKeys: [cjk] } });
  const [row] = externalActionFieldEvidence(env);
  assert.ok(Buffer.byteLength(row.valueBefore, 'utf8') <= 200, 'the row stays within the byte budget');
  assert.equal(row.valueBefore, '好'.repeat(66), '66 full characters, 198 bytes, cut on a boundary');
});

test('every row value is capped at 200 bytes, so a decision cannot carry an unbounded proof', () => {
  const env = envelope(
    { action: { kind: 'shell', command: 'my-custom-tool --check' }, args: { command: 'my-custom-tool --check' }, metadata: { inputKeys: ['a'.repeat(400)] } },
    { allowedCommands: ['my-custom-tool'] },
  );
  const rows = externalActionFieldEvidence(env);
  for (const row of rows) {
    assert.ok(row.valueBefore === null || row.valueBefore.length <= 200, row.propertyPath);
    assert.ok(row.valueAfter === null || row.valueAfter.length <= 200, row.propertyPath);
  }
  assert.equal(rows[0].valueBefore.length, 200, 'the 400-char key list is sliced to the cap');
  assert.ok(Object.isFrozen(rows) && rows.every(Object.isFrozen), 'the list and each row are frozen');
});
