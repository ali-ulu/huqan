'use strict';

/**
 * A read-only ALLOW is granted per action word, not per byte sequence (#764).
 *
 * classifyAction ran every read token -- including `get`, `list`, `open`,
 * `show`, `check`, `status` -- as a substring search over one blob built from
 * the action, the tool name AND the payload. So an unknown, possibly mutating
 * tool became low-risk read-only because `target` contains `get`, or because
 * some argument happened to contain `list`. With a valid AB1 classifier
 * attached the malformed-classifier safeguard does not fire, so that false
 * read stayed ALLOW: payload content granted authority.
 *
 * The asymmetry is deliberate and pinned below: escalation hints may still be
 * read loosely out of the whole call, because over-reading a hint can only
 * raise a decision, never lower one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  evaluateToolCall,
  hasSecretLookingValue,
  TOOL_GATE_DECISIONS,
  TOOL_GATE_REASONS,
} = require('../lib/tool-call-gate');

/** A valid low-risk AB1 classifier: the safeguard that would mask this is off. */
function lowRiskClassifier() {
  return {
    classifierVersion: 'AB1-v2.0.0',
    risk: { level: 'low', score: 0.1, category: 'read' },
    valid: true,
  };
}

const SUBSTRING_TRAPS = [
  ['target contains get', { action: 'target', toolName: 'custom-tool' }],
  ['budgeting contains get', { action: 'budgeting', toolName: 'custom-tool' }],
  ['enlist contains list', { action: 'enlist', toolName: 'custom-tool' }],
  ['reopen contains open', { action: 'reopen', toolName: 'custom-tool' }],
  ['overshadow contains show', { action: 'overshadow', toolName: 'custom-tool' }],
  ['spreadsheet contains read', { action: 'flush', toolName: 'spreadsheet-tool' }],
  ['checkout contains check', { action: 'checkout', toolName: 'custom-tool' }],
  ['statuses contains status', { action: 'statuses', toolName: 'custom-tool' }],
];

for (const [label, call] of SUBSTRING_TRAPS) {
  test(`unknown action stays under review: ${label}`, () => {
    const result = evaluateToolCall({ ...call, classifier: lowRiskClassifier() });

    assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW, `${label} was allowed`);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.reason, TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED);
    assert.equal(result.risk.category, 'unknown');
  });
}

test('payload text cannot vouch for an unknown action', () => {
  const result = evaluateToolCall({
    action: 'frobnicate',
    toolName: 'custom-tool',
    args: { note: 'please get the list and show the status', mode: 'open' },
    classifier: lowRiskClassifier(),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(result.reason, TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED);
});

test('a supplied low-risk classifier does not turn an unknown action into allow', () => {
  // The classifier's own risk assessment is metadata; it is not a second
  // opinion that can outvote the action classification.
  const result = evaluateToolCall({
    action: 'target',
    toolName: 'delete-nothing-honest',
    classifier: { classifierVersion: 'AB1-v2.0.0', risk: { level: 'minimal', score: 0, category: 'read' }, valid: true },
  });

  assert.notEqual(result.decision, TOOL_GATE_DECISIONS.ALLOW);
});

test('exact read actions still allow, however they are spelled', () => {
  const spellings = [
    { action: 'read', toolName: 'list-files' },
    { action: 'get', toolName: 'github.get_issue' },
    { action: 'getStatus', toolName: 'service' },
    { action: '', toolName: 'repo.list' },
    { action: 'FETCH', toolName: 'docs' },
  ];

  for (const call of spellings) {
    const result = evaluateToolCall({ ...call, classifier: lowRiskClassifier() });
    assert.equal(result.decision, TOOL_GATE_DECISIONS.ALLOW,
      `${call.action || '(no action)'} / ${call.toolName} should read as low risk`);
    assert.equal(result.reason, TOOL_GATE_REASONS.LOW_RISK_ACTION);
  }
});

test('mutating and destructive actions keep their stronger decisions', () => {
  const cases = [
    [{ action: 'delete', toolName: 'db' }, TOOL_GATE_DECISIONS.BLOCK],
    [{ action: 'deploy', toolName: 'service' }, TOOL_GATE_DECISIONS.DRY_RUN_ONLY],
    [{ action: 'update', toolName: 'record' }, TOOL_GATE_DECISIONS.REVIEW],
    [{ action: 'send', toolName: 'mailer' }, TOOL_GATE_DECISIONS.REVIEW],
  ];

  for (const [call, expected] of cases) {
    const result = evaluateToolCall({ ...call, classifier: lowRiskClassifier() });
    assert.equal(result.decision, expected, `${call.action} should be ${expected}`);
  }
});

test('a read-looking name does not out-rank a destructive hint in the payload', () => {
  // Escalation still reads the whole call: a hint that raises the decision is
  // safe to over-read, which is exactly why the read path may not work that way.
  const result = evaluateToolCall({
    action: 'get',
    toolName: 'reporter',
    args: { command: 'drop table users' },
    classifier: lowRiskClassifier(),
  });

  assert.equal(result.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(result.reason, TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED);
});

test('an empty call is still unknown, not read', () => {
  const result = evaluateToolCall({ classifier: lowRiskClassifier() });
  assert.equal(result.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(result.reason, TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED);
});

test('where a file sits is not a hint about the call, but what it is called still is', () => {
  // Escalation keeps reading the whole call loosely -- that asymmetry is the
  // point of this file. The correction is narrower: the directories a file
  // happens to be in say nothing about the action. Measured before the fix:
  // reading `.../wt-ship/README.md` came out dry_run_only while the same call
  // in `.../wt-base/` was allow, so a checkout directory decided the category
  // and a test's verdict depended on where it ran (#1804).
  const read = location => evaluateToolCall({
    action: 'read',
    toolName: 'Read',
    args: { file_path: location },
    classifier: lowRiskClassifier(),
  });

  for (const location of ['C:/tmp/wt-ship/README.md', 'C:/tmp/my-deploy-notes/README.md', 'scripts/publish/notes.md', '/home/me/release/README.md']) {
    assert.equal(read(location).decision, TOOL_GATE_DECISIONS.ALLOW, location);
  }

  // The file's own name is still payload that can accuse.
  assert.equal(read('C:/tmp/plain/deploy.sh').decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  // And nothing changes for the fields that describe the action itself.
  assert.equal(evaluateToolCall({
    action: 'run', toolName: 'Bash', args: { command: 'npm publish' }, classifier: lowRiskClassifier(),
  }).decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(evaluateToolCall({
    action: 'fetch', toolName: 'client', args: { url: 'https://example.com/deploy' }, classifier: lowRiskClassifier(),
  }).decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
});

test('a folder called tokens is a location, a file called credentials is still evidence', () => {
  // The same confusion in the secret detector, which AB2 and AB9 share: a
  // checkout under `.../wt-tokens/` made every call in it look like it carried
  // a secret, so the suite's verdict depended on the directory it ran in
  // (#1804). Reduced to the file's own name, both answers stay right.
  const carries = location => hasSecretLookingValue({ file_path: location });
  const windows = (...segments) => segments.join(path.sep);
  assert.equal(carries(windows('C:', 'Users', 'me', 'wt-tokens', 'README.md')), false);
  assert.equal(carries('/home/me/secret-project/README.md'), false);
  assert.equal(carries(windows('C:', 'Users', 'me', '.aws', 'credentials')), true);
  assert.equal(carries('/tmp/plain/api_key.txt'), true);
  // Content is untouched: an argument that actually carries one still counts.
  assert.equal(hasSecretLookingValue({ command: 'export TOKEN=sk-abcdefghijklmnop' }), true);
});
