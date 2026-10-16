'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLI = require('../cli');
const { runCliArgv } = require('../lib/cli-workflow-adapter');

const ROOT = path.join(__dirname, '..');

// A CLI stand-in that exposes only the public gate surface. Reaching for a
// private underscore method throws instead of silently resolving to undefined.
function publicGateCli() {
  return {
    kernel: {},
    parse: () => ({ command: 'sor', args: '' }),
    evaluateCliGate: () => ({ decision: 'block', canExecute: false, reason: 'test-block' }),
    async execute() { throw new Error('must stay gated'); },
  };
}

describe('CLI gate methods are public surface (#2283)', () => {
  it('evaluateCliGate and queueLearnReview are public and the private names are gone', () => {
    for (const name of ['evaluateCliGate', 'queueLearnReview']) {
      assert.equal(typeof CLI.prototype[name], 'function', `${name} must be public`);
      assert.equal(CLI.prototype[`_${name}`], undefined, `_${name} must be gone`);
    }
  });

  it('the workflow adapter gates through the public surface only', async () => {
    const lines = [];
    const result = await runCliArgv(['sor', 'test'], {
      cli: publicGateCli(),
      stdout: (value) => lines.push(value),
    });
    assert.equal(result.decision, 'block');
    assert.ok(lines.join('\n').length > 0, 'the blocked command must still explain itself');
  });

  it('the adapter source names no private CLI gate method', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'cli-workflow-adapter.js'), 'utf8');
    assert.doesNotMatch(source, /_evaluateCliGate|_queueLearnReview|_formatCliGateMessage/, 'lib/cli-workflow-adapter.js must not name private CLI methods');
  });
});
