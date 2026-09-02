'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  defaultExternalActionPolicyPath,
  readAllowedCommands,
} = require('../lib/external-action-command-policy');

function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-command-policy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'external-action-policy.json');
}

test('a missing policy file is an empty list, not a failure', t => {
  assert.deepEqual(readAllowedCommands(scratch(t)), []);
});

test('both shapes of policy file are accepted and entries are trimmed', t => {
  const target = scratch(t);
  fs.writeFileSync(target, JSON.stringify({ allowedCommands: ['  npm test  ', '', 42, 'node --version'] }));
  assert.deepEqual(readAllowedCommands(target), ['npm test', 'node --version']);
  fs.writeFileSync(target, JSON.stringify(['npm ci']));
  assert.deepEqual(readAllowedCommands(target), ['npm ci']);
});

test('an unreadable policy is an error, because the alternative is a quiet allow', t => {
  const target = scratch(t);
  fs.writeFileSync(target, '{ not json');
  assert.throws(() => readAllowedCommands(target), /invalid JSON in command policy/);
  fs.writeFileSync(target, JSON.stringify({ allowedCommands: 'npm test' }));
  assert.throws(() => readAllowedCommands(target), /must be an array/);
});

test('an edit reaches a long-lived process without a restart', t => {
  const target = scratch(t);
  fs.writeFileSync(target, JSON.stringify(['npm test']));
  assert.deepEqual(readAllowedCommands(target), ['npm test']);
  // Same path, new content: the reader caches on mtime and size, so an editor
  // that loaded the guard hours ago still sees this.
  fs.writeFileSync(target, JSON.stringify(['npm test', 'npm run lint']));
  fs.utimesSync(target, new Date(), new Date(Date.now() + 1000));
  assert.deepEqual(readAllowedCommands(target), ['npm test', 'npm run lint']);
  fs.rmSync(target);
  assert.deepEqual(readAllowedCommands(target), []);
});

test('the default policy path sits beside the receipt trail and follows its override', () => {
  const previous = process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
  const target = path.join(os.tmpdir(), 'huqan-policy-default', 'receipts.jsonl');
  process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = target;
  try {
    assert.equal(defaultExternalActionPolicyPath(), path.join(path.dirname(target), 'external-action-policy.json'));
  } finally {
    if (previous === undefined) delete process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
    else process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = previous;
  }
  assert.equal(path.basename(defaultExternalActionPolicyPath({ HUQAN_EXTERNAL_GUARD_POLICY: 'C:/policy/mine.json' })), 'mine.json');
});
