'use strict';
const test = require('node:test');
// #4065 G1: Coder learning is keyed by the approved task's kind of work.
const CODER_KEY = 'risk:coder:replace_text';
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
const { authorityLift } = require('./helpers/authority-lift');
const { createAgentCoderExecution } = require('../lib/agent-coder-execution');
const { createExperienceJournal } = require('../lib/experience/journal');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { beginObservation, finishObservation } = require('../lib/agent-cognition-observation');

function ordinaryFixture(t, { replacements = ['3', '2'], timeout = false, synthesis = false, persistent = false } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-coder-feedback-')));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'feature/ordinary'); git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(root, 'check.js'), timeout ? 'setInterval(() => {}, 1000);\n'
    : "require('node:assert/strict').equal(require('./value')(),2);\n");
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const candidates = replacements.map(replace => ({ type: 'replace_text', path: 'value.js', find: '1', replace }));
  const task = { id: 'ordinary', level: 'l0', allowedPaths: ['value.js'], operation: candidates[0],
    candidates, test: { command: ' node check.js ', ...(timeout ? { timeoutMs: 20 } : {}) },
    ...(synthesis ? { synthesis: { family: 'affine-integer', examples: [{ input: 0, expected: 1 }] } } : {}) };
  const goal = 'return two'; const workspaceId = 'default';
  const memoryPath = path.join(dir, 'graph.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  const journalFile = path.join(dir, 'journal.db');
  const store = persistent ? openJournalConnection({ dbPath: journalFile }) : null;
  if (persistent) assert.ok(store);
  const journal = { ...createExperienceJournal(store ? { store } : {}) };
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      authorityRef: 'fixture-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role } }) });
  const action = buildAgentCoderAction({ root, task, goal, workspaceId,
    policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: {},
    reason: 'approve exact ordinary task', evidenceDigest: created.case.evidenceDigest }).ok, true);
  const config = { root, task, goal, action, approvalRuntime, requesterContext: {}, caseId: created.case.caseId, journal };
  const coder = createAgentCoderExecution(config), step = coder.plan(goal, workspaceId)[0];
  const state = { goal, workspaceId, observabilityRunId: 'ordinary-runtime' };
  const opts = { resume: false, maxSteps: 1, maxIterations: 1,
    cognition: { percept: true, predictionError: true, reward: true, value: true, salience: true },
    cognitiveScheduler: { budget: 100, starvationWindow: 8 },
    cognitionFrame: { repo: root, branch: action.args.branch, commit: action.args.head,
      environment: 'test', actor: 'operator', time: '2026-10-25T00:00:00Z', goal, task: task.id },
    cognitionCoderExpectations: { [step.id]: { workspaceId, expected: 'passed', sourceGroup: 'ordinary-source', riskScore: 20 } } };
  const agents = [];
  t.after(() => { for (const agent of agents) agent.storage.close(); store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, git, task, goal, workspaceId, memoryPath, kernel, journal, journalFile,
    closeJournal: () => store?.close(), config, coder, step, state, opts, agents };
}

for (const replacements of [['3', '2'], ['3', '4']]) {
  test(`ordinary native candidate chain binds its final sealed result (${replacements.join(',')})`, t => {
    const f = ordinaryFixture(t, { replacements });
    const args = { graph: f.kernel.graph, state: f.state, step: f.step, opts: f.opts, coder: f.coder };
    const pending = beginObservation(args); assert.ok(pending);
    assert.equal(pending.descriptor.sourceRefs.length, 2);
    const result = f.coder.execute(args);
    const positive = replacements[1] === '2';
    assert.equal(result.ok, positive, JSON.stringify(result));
    assert.equal(result.data.attempts.length, 2);
    assert.equal(result.data.attempts[0].rolledBack, true);
    assert.equal(result.data.attempts[0].test.exitCode, 1);
    const observed = finishObservation({ ...args, pending, report: { status: positive ? 'done' : 'error', result } });
    assert.equal(observed.status, 'MEASURED', JSON.stringify({ observed,
      firstAttempt: f.journal.read(pending.descriptor.runId).filter(row => ['verification', 'run_closed'].includes(row.type)) }));
    assert.equal(observed.outcome, positive ? 'confirmed' : 'contradiction');
    const runId = `${pending.descriptor.baseRunId}:c2`;
    const sealed = readSealedRun(f.journal, runId, f.workspaceId);
    assert.equal(sealed.ok, true, JSON.stringify(sealed));
    assert.equal(observed.sourceHash, sealed.sourceHash);
    assert.notEqual(observed.sourceHash, readSealedRun(f.journal, pending.descriptor.runId, f.workspaceId).sourceHash);
    assert.equal(fs.readFileSync(path.join(f.root, 'value.js'), 'utf8'), `module.exports = () => ${positive ? '2' : '1'};\n`);
    assert.equal(f.git('status', '--porcelain') === '', !positive);
    assert.equal(finishObservation({ ...args, pending, report: { status: 'done', result: structuredClone(result) } }).status, 'ABSTAIN');
    const read = f.journal.read;
    for (const corrupt of [rows => rows.map(row => ({ ...row, workspaceId: 'other' })),
      rows => rows.map(row => ({ ...row, runId: `${row.runId}:other` })),
      () => read(pending.descriptor.runId)]) {
      f.journal.read = (...values) => corrupt(read(...values));
      assert.equal(finishObservation({ ...args, pending, report: { status: 'done', result } }).status, 'ABSTAIN');
    }
    f.journal.read = read;
  });
}

test('ordinary observation predeclares at most eight approved native candidate references', t => {
  for (const count of [8, 9]) {
    const f = ordinaryFixture(t, { replacements: Array(count).fill('2') });
    const descriptor = f.coder.observationExpectation({ state: f.state, step: f.step, decisionId: 'bounded',
      expectation: f.opts.cognitionCoderExpectations[f.step.id] });
    if (count === 9) assert.equal(descriptor, null);
    else {
      assert.equal(descriptor.sourceRefs.length, 8);
      assert.deepEqual(descriptor.sourceRefs, Array.from({ length: 8 }, (_, i) => `coder-run:${descriptor.baseRunId}:c${i + 1}`));
    }
  }
});

test('ordinary test timeout and unsupported synthesis never become observed success', t => {
  const f = ordinaryFixture(t, { replacements: ['2'], timeout: true });
  const args = { graph: f.kernel.graph, state: f.state, step: f.step, opts: f.opts, coder: f.coder };
  const pending = beginObservation(args); assert.ok(pending);
  const result = f.coder.execute(args);
  assert.equal(result.ok, false);
  assert.notEqual(result.data.attempts[0].test.reason, 'TEST_FAILED');
  assert.equal(finishObservation({ ...args, pending, report: { status: 'error', result } }).status, 'ABSTAIN');
  assert.equal(f.git('status', '--porcelain'), '');
  const unsupported = ordinaryFixture(t, { synthesis: true });
  assert.equal(beginObservation({ graph: unsupported.kernel.graph, state: unsupported.state,
    step: unsupported.step, opts: unsupported.opts, coder: unsupported.coder }), null);
});

test('ordinary AgentV3 records real native acceptance and a fresh process reads the same outcome', t => {
  const f = ordinaryFixture(t, { persistent: true });
  const agent = new AgentV3({ kernel: f.kernel, dbPath: path.join(f.dir, 'agent.db'),
    dreamExperimentLoop: false, coderExecution: f.config });
  f.agents.push(agent);
  const append = f.journal.append;
  const beforeEffects = [];
  f.journal.append = event => {
    if (event.type === 'run_started') beforeEffects.push(structuredClone(Object.values(readPredictionPairs(f.kernel.graph))
      .find(pair => pair.rewardContext?.key === 'risk:coder:replace_text')));
    return append(event);
  };
  const run = agent.run(f.goal, f.opts);
  assert.equal(run.data.steps[0].result.data.attempts.length, 2);
  assert.equal(run.data.steps[0].result.data.attempts[0].rolledBack, true);
  assert.ok(run.data.cognition.trail.some(row => row.outcome === 'confirmed'), JSON.stringify(run.data.cognition));
  assert.equal(beforeEffects.length, 2);
  assert.ok(beforeEffects.every(pair => pair.rewardContext.expected === null && pair.outcome === null));
  const pair = Object.values(readPredictionPairs(f.kernel.graph)).find(row => row.acceptance);
  assert.ok(pair);
  assert.deepEqual(pair.rewardContext, beforeEffects[0].rewardContext);
  assert.equal(pair.acceptance.sourceRef.endsWith(':c2'), true);
  assert.equal(pair.acceptance.scopeHash, pair.binding.expectationHash);
  assert.equal(pair.acceptance.sourceHash, readSealedRun(f.journal, pair.acceptance.runId, f.workspaceId).sourceHash);
  execFileSync(process.execPath, ['check.js'], { cwd: f.root, windowsHide: true });
  f.closeJournal();
  const journalDigest = createHash('sha256').update(fs.readFileSync(f.journalFile)).digest('hex');
  const child = spawnSync(process.execPath, ['-e',
    "const a=require('node:assert/strict'),Graph=require('./graph');const {readPredictionPairs}=require('./lib/prediction-outcome-pairs');"
      + "const {openJournalConnection}=require('./lib/experience/journal-connection'),{createExperienceJournal}=require('./lib/experience/journal'),{readSealedRun}=require('./lib/experience/learning-intake');"
      + "const g=new Graph({useSQLite:false,memoryPath:process.argv[1]}),s=openJournalConnection({dbPath:process.argv[2],readOnly:true});a.ok(s);"
      + "try{const p=Object.values(readPredictionPairs(g)).find(p=>p.acceptance),j=createExperienceJournal({store:s,readOnly:true}),sealed=readSealedRun(j,p.acceptance.runId,p.binding.workspaceId);"
      + "a.equal(sealed.ok,true);a.equal(sealed.sourceHash,p.acceptance.sourceHash);a.ok(p.binding.sourceRefs.includes(p.acceptance.sourceRef));console.log(JSON.stringify(p));}finally{s.close();}", f.memoryPath, f.journalFile],
  { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), pair);
  assert.equal(createHash('sha256').update(fs.readFileSync(f.journalFile)).digest('hex'), journalDigest);
});

test('native rollback observation changes the next approved Coder choice and survives a fresh process', () => {
  const { runM7FeedbackPilot } = require('../lib/cognitive-lab-m7-experiment');
  const result = runM7FeedbackPilot();
  assert.equal(result.assertsGain, false);
  const { candidate, control, observationOff } = result.arms;
  assert.deepEqual(candidate.schedulerInputs[0].before, control.schedulerInputs[0].before);
  assert.deepEqual(candidate.schedulerInputs[0].before, observationOff.schedulerInputs[0].before);
  assert.deepEqual(candidate.schedulerInputs[0].exceptUrgency, control.schedulerInputs[0].exceptUrgency);
  assert.deepEqual(candidate.steps.map(step => step.id), ['coder:first', 'coder:good']);
  assert.deepEqual(control.steps.map(step => step.id), ['coder:first', 'coder:retry']);
  assert.deepEqual(observationOff.steps.map(step => step.id), ['coder:first', 'coder:retry']);
  assert.equal(candidate.perceptKeys.first, candidate.perceptKeys.retry);
  assert.equal(candidate.firstObservation.perceptKey, candidate.perceptKeys.first);
  assert.notEqual(candidate.perceptKeys.first, candidate.perceptKeys.good);
  assert.ok(candidate.outcomes.includes('contradiction'));
  assert.ok(candidate.outcomes.includes('confirmed'));
  assert.equal(candidate.oracle.ok, true);
  assert.equal(control.oracle.ok, false);
  assert.equal(observationOff.oracle.ok, false);
  assert.equal(candidate.runStatus, 'paused');
  assert.ok(candidate.remainingSteps > 0);
  for (const arm of Object.values(result.arms)) {
    assert.equal(arm.cost.modelCalls, 0);
    assert.equal(arm.cost.networkAttempts, 0);
    assert.equal(arm.cost.executorEntries, 2);
    assert.equal(arm.cost.nativeTestCalls, 2);
    assert.equal(arm.cost.oracleCalls, 1);
    assert.equal(arm.steps[0].rolledBack, true);
  }
  assert.equal(candidate.afterFirst.entries.find(entry => entry.key === CODER_KEY).nIndependent, 1);
  assert.equal(candidate.afterFirst.entries.find(entry => entry.key === CODER_KEY).status, 'INSUFFICIENT');
  assert.deepEqual(candidate.restarted.steps.map(step => step.id), ['coder:good']);
  assert.equal(candidate.restarted.oracle.ok, true);
  assert.deepEqual(candidate.restarted.initialValue, candidate.afterFirst);
  assert.equal(candidate.restarted.prefixDigest, candidate.snapshotDigest);
  assert.equal(candidate.restarted.cost.modelCalls, 0);
  assert.equal(candidate.restarted.cost.executorEntries, 1);
  assert.ok(candidate.restarted.scopePreserved);
  assert.ok(candidate.restarted.approvalIds.every(id => !candidate.approvalIds.includes(id)));
  assert.equal(candidate.reset.kind, 'ephemeral fixture new-episode setup');
});

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
  assert.equal(authorityLift(emergencyStop)(stopTarget).ok, true);
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
