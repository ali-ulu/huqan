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

test('a huqan-namespaced tool decides identically to its bare name', () => {
  const bare = evaluateToolPolicy({ tool: 'learn', input: 'cats are animals' });
  const namespaced = evaluateToolPolicy({ tool: 'huqan.learn', input: 'cats are animals' });

  assert.equal(namespaced.category, bare.category);
  assert.equal(namespaced.action, bare.action);
  assert.equal(namespaced.approval, bare.approval);
  assert.equal(namespaced.blocked, bare.blocked);
  assert.equal(namespaced.riskScore, bare.riskScore);
  assert.equal(namespaced.category, 'internal');
  assert.equal(namespaced.action, 'allow');
});

test('the legacy axiom namespace decides identically too', () => {
  const result = evaluateToolPolicy({ tool: 'axiom.verify', input: 'cats are plants' });

  assert.equal(result.category, 'internal');
  assert.equal(result.action, 'allow');
  assert.equal(result.blocked, false);
});

test('every internal tool is internal under all three spellings', () => {
  for (const suffix of ['learn', 'ask', 'verify', 'reason', 'compare', 'dream']) {
    for (const name of [suffix, `huqan.${suffix}`, `axiom.${suffix}`]) {
      const result = evaluateToolPolicy({ tool: name, input: 'x' });
      assert.equal(result.category, 'internal', `${name} should be internal`);
      assert.equal(result.action, 'allow', `${name} should allow`);
    }
  }
});

test('the reported tool is the name the caller asked about, not the resolved one', () => {
  const result = evaluateToolPolicy({ tool: 'huqan.learn', input: 'x' });

  assert.equal(result.tool, 'huqan.learn');
});

test('an unknown suffix under a huqan namespace stays fail-closed', () => {
  // The namespace must not become a way to reach a classification the suffix
  // did not earn: only the declared MCP tool suffixes resolve.
  const unknown = evaluateToolPolicy({ tool: 'huqan.notatool', input: 'do something' });

  assert.equal(unknown.category, 'external');
  assert.equal(unknown.action, 'block');
  assert.ok(unknown.labels.includes('unknown-tool-blocked'));
});

test('a destructive string wearing a huqan namespace is still destructive', () => {
  const result = evaluateToolPolicy({ tool: 'huqan.shell.exec', input: 'delete all files' });

  assert.equal(result.category, 'external');
  assert.equal(result.action, 'block');
  assert.ok(result.labels.includes('destructive'));
});

test('namespacing does not grant the agent a tool it did not have', () => {
  // INTERNAL_TOOLS is agent.js's ALLOWED_TOOLS. Resolving the namespace must
  // not enlarge it: huqan.plan is an MCP surface tool, not an agent step.
  const { INTERNAL_TOOLS } = require('../toolPolicy');

  assert.equal(INTERNAL_TOOLS.size, 6);
  assert.equal(evaluateToolPolicy({ tool: 'huqan.plan', input: 'x' }).category, 'external');
});
