'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
const { createAgentCoderExecution, buildAgentCoderAction } = require('../lib/agent-coder-execution');
const { executeStepWithRetry } = require('../lib/agent-step-executor');

function fixture(t, replacement = '2', approve = true, synthesis = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-coder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'feat/coder');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'value.js'), synthesis ? 'module.exports = x => x + 0;\n' : 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(root, 'check.js'), `require('node:assert/strict').equal(require('./value')(${synthesis ? '1' : ''}), 2);\n`);
  git('add', '.');
  git('commit', '-m', 'fixture');
  const task = { id: 'repair-value', level: 'l0', intent: 'return two', allowedPaths: ['value.js'],
    operation: { type: 'replace_text', path: 'value.js', find: '1', replace: replacement },
    test: { command: 'node check.js' } };
  if (synthesis) {
    task.operation = { type: 'replace_text', path: 'value.js' };
    task.synthesis = { family: 'affine-integer', examples: [
      { input: 0, expected: 1 }, { input: 1, expected: 2 }, { input: 2, expected: 3 },
    ] };
  }
  const goal = 'Return two in the approved module';
  const workspaceId = 'coder-workspace';
  const action = buildAgentCoderAction({ root, task, goal, workspaceId, policyVersion: 'policy-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph, ledger: createTrustEvidenceLedger({ graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      authorityRef: 'workspace-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role,
    } }),
  });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  if (approve) assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve',
    approverContext: {}, reason: 'approved bounded test repair', evidenceDigest: created.case.evidenceDigest }).ok, true);
  const config = { root, task, goal, action, caseId: created.case.caseId, approvalRuntime, requesterContext: {} };
  const adapter = createAgentCoderExecution(config);
  const state = { goal, workspaceId };
  const step = adapter.plan(goal, workspaceId)[0];
  return { root, task, goal, workspaceId, git, config, adapter, state, step, approvalRuntime };
}

test('real approved Coder execution changes source only after reservation and independent test', t => {
  const f = fixture(t);
  assert.equal(f.adapter.approvalId, f.config.caseId);
  assert.equal(Object.getOwnPropertyDescriptor(f.adapter, 'approvalId').writable, false);
  const prepared = f.adapter.prepare({ step: f.step, state: f.state });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(f.approvalRuntime.getReviewCase(f.config.caseId).case.status, 'approved');
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.type, 'coder');
  assert.equal(result.data.outcome, 'applied_tested');
  assert.match(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), /=> 2/u);
  assert.equal(f.approvalRuntime.getReviewCase(f.config.caseId).case.status, 'executed');
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
});

test('independent failing test restores original source', t => {
  const f = fixture(t, '3');
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, false);
  assert.equal(result.data.outcome, 'needs_human_decision');
  assert.match(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), /=> 1/u);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('approved synthesis uses the existing model-free search and independent test', t => {
  const f = fixture(t, '2', true, true);
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.synthesis.family, 'affine-integer');
  assert.equal(result.data.outcome, 'applied_tested');
  execFileSync(process.execPath, ['check.js'], { cwd: f.root, windowsHide: true });
});

test('queue authority, task tampering, workspace drift and changed HEAD cannot authorize Coder', t => {
  const f = fixture(t);
  for (const [step, state] of [
    [{ ...f.step, input: { ...f.step.input, authorized: true } }, f.state],
    [{ ...f.step, input: { ...f.step.input, taskId: 'other' } }, f.state],
    [f.step, { ...f.state, workspaceId: 'other' }],
    [f.step, { ...f.state, goal: 'other' }],
  ]) assert.equal(f.adapter.execute({ step, state }).ok, false);
  f.git('checkout', '-b', 'feat/other');
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
  f.git('checkout', 'feat/coder');
  f.git('commit', '--allow-empty', '-m', 'head drift');
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
  assert.match(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), /=> 1/u);
});

test('unapproved case and constructor task substitution fail closed', t => {
  const f = fixture(t, '2', false);
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
  const changed = createAgentCoderExecution({ ...f.config, task: { ...f.task, operation: { ...f.task.operation, replace: '3' } } });
  assert.equal(changed.execute({ step: f.step, state: f.state }).ok, false);
});

test('host mutation does not replace the approved task and plan refuses another goal', t => {
  const f = fixture(t);
  assert.deepEqual(f.adapter.plan('another goal', f.workspaceId), []);
  assert.deepEqual(f.adapter.plan(f.goal, 'another workspace'), []);
  f.task.operation.replace = '9';
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), /=> 2/u);
});

test('dirty source and executable task properties cannot reach an executor', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'extra.txt'), 'untracked');
  assert.equal(f.adapter.prepare({ step: f.step, state: f.state }).ok, false);
  fs.rmSync(path.join(f.root, 'extra.txt'));
  let reads = 0;
  const unsafe = { ...f.task, get operation() { reads++; return f.task.operation; } };
  const adapter = createAgentCoderExecution({ ...f.config, task: unsafe });
  assert.equal(adapter.execute({ step: f.step, state: f.state }).ok, false);
  assert.equal(reads, 0);
});

test('a host approval runtime that throws in authorizeExecution is a blocked step, not an escaped exception', t => {
  const f = fixture(t);
  const fault = () => { throw new Error('HOST_RUNTIME_FAULT'); };
  const throwing = { authorizeExecution: fault, executeApprovedSync: fault };
  const adapter = createAgentCoderExecution({ ...f.config, approvalRuntime: throwing });
  const prepared = adapter.prepare({ step: f.step, state: f.state });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, 'HOST_RUNTIME_FAULT');
  const executed = adapter.execute({ step: f.step, state: f.state });
  assert.equal(executed.ok, false);
  assert.equal(executed.error.code, 'HOST_RUNTIME_FAULT');
  assert.equal(executed.meta.blocked, true);
  assert.equal(executed.meta.uncertain, undefined);
});

test('an execution that ran but lost its outcome is uncertain, not blocked', t => {
  const f = fixture(t);
  // The executor runs and changes the repository; the runtime then loses track
  // of the outcome, which is the reconciliation-required path.
  const runtime = { ...f.config.approvalRuntime,
    executeApprovedSync: ({ executor }) => { executor(); return { ok: false, reason: 'approval.execution_reconciliation_required' }; } };
  const adapter = createAgentCoderExecution({ ...f.config, approvalRuntime: runtime });
  const result = adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, false);
  assert.equal(result.meta.blocked, false);
  assert.equal(result.meta.uncertain, true);
  assert.equal(result.error.code, 'approval.execution_reconciliation_required');
  assert.match(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), /=> 2/u);
});

test('an uncertain step is returned without a retry or a failure record', () => {
  const report = { id: 'coder:repair-value', tool: 'coder', status: 'error',
    result: { ok: false, error: { code: 'approval.execution_reconciliation_required' }, meta: { blocked: false, uncertain: true } } };
  let calls = 0;
  let failures = 0;
  const returned = executeStepWithRetry({ step: { id: 'coder:repair-value' }, state: {}, opts: { stepRetries: 3 },
    executeStep: () => { calls += 1; return report; },
    recordFailure: () => { failures += 1; }, isRetryable: () => true });
  assert.equal(calls, 1);
  assert.equal(failures, 0);
  assert.equal(returned, report);
});
