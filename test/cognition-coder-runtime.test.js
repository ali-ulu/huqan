'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
const { buildAgentCoderAction } = require('../lib/agent-coder-execution');
const { createEmergencyStop, approvalStopAgentId } = require('../lib/emergency-stop');

for (const failOutcome of [false, true]) test(`real AgentV3 Coder plan preserves outcome durability (failure=${failOutcome})`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cognition-coder-'));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'feat/repair');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = n => n + 1;\n');
  fs.writeFileSync(path.join(root, 'check.js'), "const a=require('node:assert/strict'),f=require('./value');a.equal(f(5),13);a.equal(f(8),22);\n");
  git('add', '.'); git('commit', '-m', 'fixture');
  const task = { id: 'affine-repair', level: 'l0', allowedPaths: ['value.js'],
    operation: { type: 'replace_text', path: 'value.js' }, test: { command: 'node check.js' },
    synthesis: { family: 'affine-integer', examples: [
      { input: 0, expected: -2 }, { input: 1, expected: 1 }, { input: 3, expected: 7 } ] } };
  const goal = 'repair value'; const workspaceId = 'default';
  const memoryPath = path.join(dir, 'memory.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  const action = buildAgentCoderAction({ root, task, goal, workspaceId,
    policyVersion: 'coder-test-policy', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'agent-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      agentId: role === 'requester' ? 'coder' : '', ownerActorId: role, authorityRef: 'fixture-owner' } }) });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve',
    approverContext: {}, reason: 'operator approved exact source and independent test',
    evidenceDigest: created.case.evidenceDigest }).ok, true);
  const agent = new AgentV3({ kernel, dbPath: path.join(dir, 'agent.db'), dreamExperimentLoop: false,
    coderExecution: { root, task, goal, action, approvalRuntime, requesterContext: {}, caseId: created.case.caseId } });
  t.after(() => { agent.storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const emergencyStop = createEmergencyStop({ directory: path.join(dir, 'stops') });
  const stopTarget = { scope: 'agent', workspaceId, agentId: approvalStopAgentId(created.case.caseId),
    reason: 'operator cancelled Coder case', actor: 'operator' };
  assert.equal(emergencyStop.stop(stopTarget).ok, true);
  const stopped = agent.run(goal, { resume: false, maxIterations: 1, maxSteps: 1,
    emergencyStop, approvalId: 'unrelated-run-approval' });
  assert.equal(stopped.data.steps[0].result.error.code, 'AGENT_EMERGENCY_STOPPED');
  assert.equal(approvalRuntime.getReviewCase(created.case.caseId).case.status, 'approved');
  assert.equal(fs.readFileSync(path.join(root, 'value.js'), 'utf8'), 'module.exports = n => n + 1;\n');
  assert.equal(emergencyStop.lift(stopTarget).ok, true);
  const frame = { repo: root, branch: action.args.branch, commit: action.args.head,
    environment: 'test', actor: 'operator', time: new Date().toISOString(), goal, task: task.id };
  const expectedSource = 'module.exports = n => ((n * 3) - 2);\n';
  if (failOutcome) {
    const mutate = kernel.graph.runMutationOnce.bind(kernel.graph);
    kernel.graph.runMutationOnce = (operationId, ...args) => {
      if (operationId.startsWith('human-oversight:execution-outcome:')) throw new Error('OUTCOME_WRITE_FAILED');
      return mutate(operationId, ...args);
    };
  }
  const run = agent.run(goal, { resume: false, maxIterations: 1, maxSteps: 1, emergencyStop,
    cognition: { predictionError: true, reward: true, value: true, percept: true, salience: true },
    cognitiveScheduler: { budget: 100, starvationWindow: 8 }, cognitionFrame: frame,
    cognitionFileExpectations: { 'coder:affine-repair': { workspaceId, path: path.join(root, 'value.js'),
      sourceGroup: 'affine-source', expectedDigest: createHash('sha256').update(expectedSource).digest('hex') } } });
  if (failOutcome) {
    assert.equal(run.data.status, 'paused');
    assert.equal(run.data.steps.length, 0, 'uncertain effects must not become completed steps');
    assert.equal(run.data.queuedSteps[0].id, 'coder:affine-repair');
    assert.equal(approvalRuntime.getReviewCase(created.case.caseId).case.status, 'executing');
    assert.equal(fs.readFileSync(path.join(root, 'value.js'), 'utf8'), expectedSource);
    assert.ok(!run.data.cognition.trail.some(row => row.outcome), 'uncertain effects must not become rewards');
    return;
  }
  assert.equal(run.data.steps[0].tool, 'coder');
  assert.equal(run.data.steps[0].status, 'done', JSON.stringify(run));
  assert.equal(run.data.steps[0].result.data.outcome, 'applied_tested');
  assert.equal(fs.readFileSync(path.join(root, 'value.js'), 'utf8'), expectedSource);
  execFileSync(process.execPath, ['check.js'], { cwd: root, windowsHide: true });
  assert.equal(approvalRuntime.getReviewCase(created.case.caseId).case.status, 'executed');
  assert.ok(run.data.cognition.trail.some(row => row.outcome === 'confirmed'));
  const child = spawnSync(process.execPath, ['-e',
    "const Graph=require('./graph');const {readPredictionPairs}=require('./lib/prediction-outcome-pairs');const g=new Graph({useSQLite:false,memoryPath:process.argv[1]});console.log(JSON.stringify(Object.values(readPredictionPairs(g)).map(p=>p.outcome?.state)));", memoryPath],
  { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(JSON.parse(child.stdout).includes('confirmed'));
});
