'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toShellEvent, classifyCommand } = require('./examples/shell-observation-client');

describe('shell exec spike', () => {
  it('hints allow for read-only commands', () => {
    assert.strictEqual(classifyCommand('git status'), 'allow');
  });

  it('hints block for deployment and destructive commands', () => {
    assert.strictEqual(classifyCommand('git push origin main'), 'block');
    assert.strictEqual(classifyCommand('rm -rf /tmp/x'), 'block');
  });

  it('hints review for composition and unknowns (never silent allow)', () => {
    assert.strictEqual(classifyCommand('ls -la > out.txt'), 'review');
    assert.strictEqual(classifyCommand('npm test'), 'review');
  });

  it('emits a content-free envelope carrying the hint', () => {
    const event = toShellEvent({ agentId: 'coder', runId: 'r1', stepId: 's1', command: 'git push origin main' });
    assert.strictEqual(event.schemaVersion, 'huqan.external-event.v1');
    assert.strictEqual(event.action, 'shell.requested');
    assert.strictEqual(event.decision, 'block');
    assert.match(event.input_hash, /^[0-9a-f]{64}$/);
  });
});
