'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');
const { ACTION_CATEGORIES } = require('../lib/action-risk-classifier');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');

// #4074 (audit F-3): the external-action envelope propagated a caller's
// `riskCategory` verbatim, so the caller picked the rule the gate ran. The
// READ_ONLY rule is the only one that can ALLOW, so a payload that declared
// it had a production command graded as a low-risk read and the production
// block never ran.
//
// These tests drive the real hook: the payload arrives on stdin, which is how
// the deployed command receives it.
const PROJECTION_ENV = Object.freeze({
  ...process.env,
  HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
  HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
});

function runHook(payload, directory) {
  return spawnSync(process.execPath, [
    hook,
    '--profile', 'generic',
    '--workspace-root', root,
    '--receipt-log', path.join(directory, 'receipts.jsonl'),
    '--memory-path', path.join(directory, 'memory.json'),
    '--db-path', path.join(directory, 'memory.db'),
  ], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: PROJECTION_ENV,
  });
}

function payload(command, extra = {}) {
  return {
    invocationId: `f3-${command}`,
    agentName: 'future-agent-2035',
    sessionId: 'f3-session',
    toolName: 'shell',
    args: { command },
    cwd: root,
    workspaceRoot: root,
    ...extra,
  };
}

function decisionOf(child) {
  return JSON.parse(child.stdout);
}

// The commands the audit named: each one the shape grades as a deployment,
// and each one the payload can try to pass off as a read.
const DEPLOYMENT_COMMANDS = [
  'git push --force origin main',
  'npm publish --tag latest',
  'kubectl delete namespace prod',
  'terraform apply -auto-approve',
];

test('a declared risk category does not downgrade a deployment command', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-f3-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const command of DEPLOYMENT_COMMANDS) {
    const honest = runHook(payload(command), directory);
    const forged = runHook(payload(command, { riskCategory: ACTION_CATEGORIES.READ_ONLY }), directory);

    assert.equal(decisionOf(honest).decision, 'block', `${command} was not blocked honestly`);
    assert.equal(decisionOf(forged).decision, 'block', `${command} was allowed by a declared category`);
    assert.equal(
      decisionOf(forged).reason,
      decisionOf(honest).reason,
      `${command} was refused for a different reason`,
    );
  }
});

test('a declared risk category does not downgrade the other shape-graded actions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-f3-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  // A filesystem write the shape graded as such, and a permission change:
  // both carry a check of their own, and a declared category must not
  // replace it.
  for (const command of ['echo x > /etc/sudoers', 'cp evil /etc/sudoers', 'chmod 777 /etc/passwd']) {
    const honest = runHook(payload(command), directory);
    const forged = runHook(payload(command, { riskCategory: ACTION_CATEGORIES.READ_ONLY }), directory);

    assert.equal(decisionOf(honest).decision, 'block', `${command} was not blocked honestly`);
    assert.equal(decisionOf(forged).decision, 'block', `${command} was allowed by a declared category`);
  }
});

test('the envelope grades the action by its shape, not by the declared category', () => {
  const envelope = normalizeExternalActionEnvelope(
    payload('git push --force origin main', { riskCategory: ACTION_CATEGORIES.READ_ONLY }),
    {},
  );

  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.DEPLOYMENT);
});

test('a declared category may still raise an action the shape did not recognise', () => {
  // The legitimate use: a financial action's shape is a tool call the
  // envelope cannot classify, and the financial policy judges the money
  // details. A declaration that is stricter than the shape keeps working --
  // only the direction that lowers an action is refused.
  const envelope = normalizeExternalActionEnvelope(
    payload('payment.execute', {
      toolName: 'payment.execute',
      args: { amount: 42, currency: 'EUR', destination: 'vendor-7', reversible: true },
      riskCategory: ACTION_CATEGORIES.FINANCIAL_TRANSACTION,
    }),
    {},
  );

  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.FINANCIAL_TRANSACTION);
});

test('a declared category that is stricter than a read is honoured', () => {
  // READ_ONLY is the only rule that can ALLOW, so any stricter rule may take
  // its place without permitting anything the shape would not.
  const envelope = normalizeExternalActionEnvelope(
    payload('read a file', {
      toolName: 'read',
      args: {},
      riskCategory: ACTION_CATEGORIES.FINANCIAL_TRANSACTION,
    }),
    { workspaceRoot: root },
  );

  assert.equal(envelope.kind, 'file_read');
  assert.equal(envelope.riskCategory, ACTION_CATEGORIES.FINANCIAL_TRANSACTION);
});

test('the filesystem-write and permission shapes are graded as such, whatever is declared', () => {
  const expected = {
    'cp evil /etc/sudoers': ACTION_CATEGORIES.FILESYSTEM_WRITE,
    'chmod 777 /etc/passwd': ACTION_CATEGORIES.PERMISSION_CHANGE,
  };
  for (const [command, category] of Object.entries(expected)) {
    const envelope = normalizeExternalActionEnvelope(
      payload(command, { riskCategory: ACTION_CATEGORIES.READ_ONLY }),
      {},
    );
    assert.equal(envelope.riskCategory, category, command);
  }
});
