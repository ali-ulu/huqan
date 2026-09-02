'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CONTROL_PLANE_PATH_RULES,
  isControlPlanePath,
  findControlPlaneCommandTarget,
} = require('../lib/control-plane-paths');

test('recognizes the guard control plane of every shipped adapter profile', () => {
  const cases = [
    ['.claude/settings.json', 'claude-code'],
    ['.claude/settings.local.json', 'claude-code'],
    ['.claude/hooks/huqan-gate.sh', 'claude-code'],
    ['.codex/hooks.json', 'codex'],
    ['.opencode/plugin/huqan.mjs', 'opencode'],
    ['.pi/extensions/huqan.js', 'pi'],
    ['.hermes/plugins/huqan-external-action-guard/plugin.json', 'hermes'],
    ['adapters/external-action/claude-code-hooks.json', 'huqan'],
  ];
  for (const [candidate, profile] of cases) {
    const match = isControlPlanePath(candidate);
    assert.ok(match, `expected ${candidate} to be control plane`);
    assert.equal(match.profile, profile);
  }
});

test('matches regardless of path separator, absolute prefix or case on the marker', () => {
  const variants = [
    'C:\\Users\\a\\proj\\.claude\\settings.json',
    '/home/a/proj/.claude/settings.json',
    './.claude/settings.json',
    'proj/.claude//settings.json',
  ];
  for (const candidate of variants) {
    assert.ok(isControlPlanePath(candidate), `expected ${candidate} to be control plane`);
  }
});

test('does not treat ordinary workspace files as control plane', () => {
  const benign = [
    'lib/external-action-guard.js',
    'src/settings.json',
    'docs/claude/settings.json.md',
    '.claude/README.md',
    'test/fixtures/opencode/plugin-notes.txt',
    '',
    null,
  ];
  for (const candidate of benign) {
    assert.equal(isControlPlanePath(candidate), null, `expected ${candidate} to be ordinary`);
  }
});

test('flags shell commands that mutate the control plane', () => {
  const mutations = [
    'rm .claude/settings.json',
    'rm -f ~/.claude/settings.json',
    "sed -i 's/huqan-gate//' .claude/settings.json",
    'mv .codex/hooks.json /tmp/backup.json',
    'echo "{}" > .claude/settings.json',
    'truncate -s 0 .pi/extensions/huqan.js',
    'cp /tmp/clean.json .opencode/plugin/huqan.mjs',
  ];
  for (const command of mutations) {
    const match = findControlPlaneCommandTarget(command);
    assert.ok(match, `expected ${command} to be flagged`);
  }
});

test('leaves read-only inspection of the control plane alone', () => {
  const reads = [
    'cat .claude/settings.json',
    'grep huqan-gate .claude/settings.json',
    'ls -la .claude',
    'git diff .claude/settings.json',
    'rm build/artifacts.json',
  ];
  for (const command of reads) {
    assert.equal(findControlPlaneCommandTarget(command), null, `expected ${command} to pass`);
  }
});

test('every rule carries the profile it protects', () => {
  for (const rule of CONTROL_PLANE_PATH_RULES) {
    assert.ok(rule.profile, 'rule is missing a profile');
    assert.ok(rule.pattern instanceof RegExp, 'rule is missing a pattern');
  }
});

// ── guard integration ───────────────────────────────────────────────────────
//
// The unit tests above prove the rules recognize the right files. These prove
// the guard acts on them: that disarming the wiring is a `block`, not one more
// `review` an operator can wave through by habit, and that ordinary work in the
// same workspace is untouched.

const { evaluateExternalAction } = require('../lib/external-action-guard');

const workspaceRoot = path.resolve(__dirname, '..');

function memoryWriter() {
  const receipts = [];
  return { receipts, append(receipt) { receipts.push(receipt); } };
}

function evaluate(overrides, options = {}) {
  return evaluateExternalAction({
    invocationId: 'cp-1',
    agentName: 'kacak-agent',
    sessionId: 'cp-session',
    cwd: workspaceRoot,
    workspaceRoot,
    ...overrides,
  }, { receiptWriter: memoryWriter(), ...options });
}

test('blocks writing the hook config that decides whether the guard runs', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, '.claude', 'settings.json'), content: '{}' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'external_action_control_plane_blocked');
  assert.equal(result.canExecute, false);
});

test('blocks shell commands that delete or rewrite the hook config', () => {
  for (const command of ['rm .claude/settings.json', "sed -i 's/huqan-gate//' .claude/settings.json"]) {
    const result = evaluate({ toolName: 'Bash', args: { command } });
    assert.equal(result.decision, 'block', command);
    assert.equal(result.reason, 'external_action_control_plane_blocked', command);
  }
});

test('records which profile the control plane belonged to', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, '.opencode', 'plugin', 'huqan.mjs'), content: 'x' },
  });
  const finding = result.findings.find(entry => entry.gate === 'control-plane');
  assert.ok(finding, 'expected a control-plane finding');
  assert.equal(finding.profile, 'opencode');
});

test('reading the hook config is left alone', () => {
  const result = evaluate({ toolName: 'Bash', args: { command: 'cat .claude/settings.json' } });
  assert.notEqual(result.reason, 'external_action_control_plane_blocked');
});

test('ordinary workspace writes keep their previous decision', () => {
  const result = evaluate({
    toolName: 'Write',
    args: { file_path: path.join(workspaceRoot, 'lib', 'scratch.js'), content: 'x' },
  });
  assert.notEqual(result.decision, 'block');
});

test('allowControlPlane comes from deployment options, never from the payload', () => {
  const args = { file_path: path.join(workspaceRoot, '.claude', 'settings.json'), content: '{}' };

  // An agent asking for the exemption inside its own invocation changes nothing.
  const selfGranted = evaluate({ toolName: 'Write', args, allowControlPlane: true });
  assert.equal(selfGranted.decision, 'block');

  // The deployment that installed the hook can still do maintenance.
  const maintenance = evaluate({ toolName: 'Write', args }, { allowControlPlane: true });
  assert.notEqual(maintenance.reason, 'external_action_control_plane_blocked');
});
