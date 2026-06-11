const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateToolPolicy } = require('../toolPolicy');

test('internal tool remains allow', () => {
  const result = evaluateToolPolicy({ tool: 'ask', input: 'kedi nedir?' });

  assert.equal(result.category, 'internal');
  assert.equal(result.action, 'allow');
  assert.equal(result.blocked, false);
  assert.equal(result.requiresApproval, false);
});

test('known external review tool remains review', () => {
  const result = evaluateToolPolicy({ tool: 'browser.open', input: 'open docs' });

  assert.equal(result.category, 'external');
  assert.equal(result.action, 'review');
  assert.equal(result.approval, 'review');
  assert.equal(result.blocked, false);
  assert.equal(result.requiresApproval, true);
});

test('unknown external tool is fail-closed block', () => {
  const result = evaluateToolPolicy({ tool: 'unknown.tool', input: 'do something' });

  assert.equal(result.category, 'external');
  assert.equal(result.action, 'block');
  assert.equal(result.approval, 'blocked');
  assert.equal(result.blocked, true);
  assert.equal(result.requiresApproval, false);
  assert.ok(result.labels.includes('unknown-tool-blocked'));
  assert.ok(result.reasons.some((reason) => reason.includes('fail-closed')));
});
