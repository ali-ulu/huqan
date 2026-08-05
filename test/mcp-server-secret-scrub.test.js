const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeToolArgsForStorage, executeReadOnlyDryRun } = require('../mcpServer');

test('sanitizeToolArgsForStorage redacts secret-looking values before they reach the approval store', () => {
  const clean = sanitizeToolArgsForStorage('axiom.agent', {
    goal: 'plan something',
    apiKey: 'sk-abcdefghijklmnop',
  });

  assert.equal(clean.goal, 'plan something');
  assert.equal(clean.apiKey, '[REDACTED]');
});

test('sanitizeToolArgsForStorage leaves non-secret args untouched', () => {
  const clean = sanitizeToolArgsForStorage('axiom.agent', {
    goal: 'plan something',
    maxSteps: 3,
    dryRun: true,
  });

  assert.deepEqual(clean, { goal: 'plan something', maxSteps: 3, dryRun: true });
});

test('sanitizeToolArgsForStorage keeps the axiom.learn allowlist unchanged (text is knowledge content, not scrubbed)', () => {
  const clean = sanitizeToolArgsForStorage('axiom.learn', {
    text: 'kedi hayvandir',
    apiKey: 'sk-abcdefghijklmnop',
    skipConflicts: true,
  });

  assert.deepEqual(clean, { text: 'kedi hayvandir', skipConflicts: true });
  assert.equal('apiKey' in clean, false, 'axiom.learn allowlist already excludes unexpected fields');
});

test('executeReadOnlyDryRun scrubs secrets from the raw-args echo for unmapped tools', () => {
  const result = executeReadOnlyDryRun(null, 'axiom.compare', {
    left: 'kedi',
    right: 'kopek',
    token: 'tok_live_abcdefgh',
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.tool, 'axiom.compare');
  assert.equal(result.args.left, 'kedi');
  assert.equal(result.args.token, '[REDACTED]');
});
