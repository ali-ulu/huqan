'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDeadCode } = require('./check-dead-code');

const REPO_ROOT = path.join(__dirname, '..');

test('repo root passes dead-code check (module reachability slice)', () => {
  const result = checkDeadCode({ root: REPO_ROOT });
  assert.equal(result.ok, true, result.report);
  assert.equal(result.unacknowledged.length, 0);
  assert.equal(result.staleAcknowledgements.length, 0);
  assert.ok(result.reachableCount > 50, 'walk must see real product modules');
});

test('an unclassified orphan fails the gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), "require('./used');\n");
    fs.writeFileSync(path.join(root, 'used.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'orphan.js'), 'module.exports = {};\n');

    const result = checkDeadCode({ root });
    assert.equal(result.ok, false);
    assert.ok(result.unacknowledged.includes('orphan.js'));
    assert.match(result.report, /orphan\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
