'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultExternalActionPolicyPath, readAllowedCommands } = require('../lib/external-action-command-policy');

test('default command policy path is isolated per workspace (#2063)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2063-'));
  const environment = { HUQAN_EXTERNAL_GUARD_RECEIPTS: path.join(root, 'receipts.jsonl') };
  try {
    const one = defaultExternalActionPolicyPath(environment, 'production');
    const two = defaultExternalActionPolicyPath(environment, 'staging');
    assert.notEqual(one, two);
    fs.mkdirSync(path.dirname(one), { recursive: true });
    fs.mkdirSync(path.dirname(two), { recursive: true });
    fs.writeFileSync(one, JSON.stringify({ allowedCommands: ['npm test'] }));
    fs.writeFileSync(two, JSON.stringify({ allowedCommands: ['node --version'] }));
    assert.deepEqual(readAllowedCommands(one), ['npm test']);
    assert.deepEqual(readAllowedCommands(two), ['node --version']);
    assert.equal(defaultExternalActionPolicyPath(environment), path.join(root, 'external-action-policy.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
