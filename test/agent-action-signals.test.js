'use strict';

// Direct characterisation of the agent action signal helpers, whose edges
// were reached only incidentally through full agent runs. Writing it found
// summarizeGoalIntegrity passing a length to firstText (a first-non-empty
// helper): a missing goalFingerprint, version or policyVersion came back as
// the text '64', so an incomplete goal-integrity record read as complete.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  actionText,
  buildMetadata,
  hasAutomationMarker,
  hasStructuredAction,
  inputFieldEvidence,
} = require('../lib/agent-action-signals');

test('actionText folds structured values but never a structured target', () => {
  const text = actionText({
    tool: 'Shell',
    action: 'Run',
    input: { command: 'LS -LA', workflow: { name: 'Deploy-Prod' }, target: { repo: 'secret-repo' } },
  });
  assert.match(text, /shell run ls -la/);
  assert.match(text, /deploy-prod/, 'an object value is serialized into the text');
  assert.ok(!text.includes('secret-repo'), 'a structured target is not folded in');
  assert.equal(actionText({ tool: 'ask', input: ['command'] }), 'ask', 'an array input carries no structured keys');
});

test('automation markers match whole words and tolerate empty input', () => {
  assert.equal(hasAutomationMarker('please force-push to main'), true);
  assert.equal(hasAutomationMarker('pushover'), false);
  assert.equal(hasAutomationMarker(null), false);
  assert.equal(hasAutomationMarker(undefined), false);
  assert.equal(hasStructuredAction({ cmd: 'x' }), true);
  assert.equal(hasStructuredAction(['cmd']), false);
});

test('metadata falls back to the context metadata workspace and the goal-integrity defaults', () => {
  const meta = buildMetadata({
    tool: 'ask',
    input: { operation: 'read' },
    context: {
      metadata: { workspaceId: 'w-meta' },
      goalIntegrity: { goalFingerprint: 'fp', goalScopeId: 'scope', immutable: true },
    },
  });
  assert.equal(meta.workspaceId, 'w-meta');
  assert.equal(meta.action, 'read');
  assert.equal(meta.surface, 'agent');
  assert.deepEqual(meta.goalIntegrity, {
    version: '', goalFingerprint: 'fp', goalScopeId: 'scope', workspaceId: 'default',
    sourceClass: 'caller_goal', policyVersion: '', immutable: true,
  });
  assert.match(meta.actionId, /^[0-9a-f]{24}$/);
  const long = buildMetadata({ tool: 'ask', context: { goalIntegrity: { goalFingerprint: ` ${'f'.repeat(80)} `, goalScopeId: 's', version: 7 } } });
  assert.equal(long.goalIntegrity.goalFingerprint, 'f'.repeat(64), 'trimmed and bounded');
  assert.equal(long.goalIntegrity.version, '', 'a non-string version is not invented');
});

test('an incomplete goal-integrity record is left out of the metadata', () => {
  for (const goalIntegrity of [{ goalFingerprint: 'fp' }, { goalScopeId: 'scope' }, [], 'x', null]) {
    const meta = buildMetadata({ tool: 'ask', input: {}, context: { goalIntegrity } });
    assert.equal(Object.hasOwn(meta, 'goalIntegrity'), false, JSON.stringify(goalIntegrity));
    assert.equal(meta.workspaceId, 'default');
  }
});

test('input field evidence names only the fields the firewall actually clipped, as lengths', () => {
  const long = 'x'.repeat(600);
  const rows = inputFieldEvidence({ command: long, target: 'short', action: 42, nested: long });
  // `nested` is not a structured action key, `action` is not a string, and
  // `target` is under the clip, so only `command` was actually cut.
  assert.deepEqual(rows, [{ propertyPath: 'input.command', valueBefore: '600', valueAfter: '512' }]);
  assert.ok(Object.isFrozen(rows[0]), 'each row is frozen');
  assert.equal(Object.hasOwn(rows[0], 'value'), false, 'the value itself never lands in the row');
});

test('input field evidence is empty for a missing, non-object or array input', () => {
  for (const input of [undefined, null, 'text', 7, ['command'], true]) {
    assert.deepEqual(inputFieldEvidence(input), [], String(input));
  }
});

test('input field evidence carries at most one row per structured key, so it is bounded by construction', () => {
  const long = 'y'.repeat(600);
  const input = {};
  for (const key of ['action', 'operation', 'operationType', 'intent', 'command', 'cmd', 'shell', 'script', 'exec', 'target', 'deploy', 'release', 'merge', 'workflow', 'branch', 'baseBranch']) {
    input[key] = long;
  }
  const rows = inputFieldEvidence(input);
  assert.equal(rows.length, 16, 'one row per structured key, never more');
  assert.equal(rows[15].propertyPath, 'input.baseBranch');
});
