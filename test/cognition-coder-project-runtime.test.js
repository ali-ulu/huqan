'use strict';
const test = require('node:test');
// #4065 G1: Coder learning is keyed by the approved task's kind of work.
const CODER_KEY = 'risk:coder:initialize_project:array-map';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Graph = require('../graph');
const { beginObservation, finishObservation } = require('../lib/agent-cognition-observation');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { DEFAULT_SUMMARY_WINDOW } = require('../lib/cognition/prediction-error');

function environment(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-observe-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  const target = path.join(root, 'src', 'logic.js');
  const content = 'module.exports = values => values.map(value => value * 2);\n';
  const state = { workspaceId: 'default', observabilityRunId: 'create-project', goal: 'create doubles API' };
  const step = { id: 'coder:project', tool: 'coder', action: 'code_change' };
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(directory, 'graph.json') });
  const opts = { cognitionFrame: { repo: 'fixture', branch: 'feature/project', commit: 'source-v1',
    environment: 'test', actor: 'operator', time: '2026-10-25T00:00:00Z', goal: state.goal, task: step.id },
  cognitionFileExpectations: { [step.id]: { workspaceId: 'default', path: target, sourceGroup: 'project-source',
    expectedDigest: createHash('sha256').update(content).digest('hex'), riskScore: 0 } } };
  return { directory, root, target, content, state, step, graph, opts };
}

test('predeclared absent project artifact is observed from its actual creation', t => {
  const f = environment(t);
  const pending = beginObservation(f);
  assert.ok(pending, 'the expectation precedes project directory/file creation');
  assert.equal(pending.before.state, 'absent');
  fs.mkdirSync(path.dirname(f.target)); fs.writeFileSync(f.target, f.content);
  const observed = finishObservation({ ...f, pending, report: { status: 'done' } });
  assert.equal(observed.status, 'MEASURED', JSON.stringify(observed));
  assert.equal(observed.outcome, 'confirmed');
  const first = readPredictionPairs(f.graph);
  assert.equal(Object.values(first).filter(pair => pair.outcome).length, 1);
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).replayed, true);
  assert.deepEqual(readPredictionPairs(f.graph), first);
});

test('reported success without the created artifact remains an abstention', t => {
  const f = environment(t); const pending = beginObservation(f);
  assert.ok(pending);
  const result = finishObservation({ ...f, pending, report: { status: 'done' } });
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(Object.values(readPredictionPairs(f.graph)).filter(pair => pair.outcome).length, 0);
});

test('a new junction cannot redirect an approved missing artifact observation', t => {
  const f = environment(t); const pending = beginObservation(f); assert.ok(pending);
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'logic.js'), f.content);
  fs.symlinkSync(outside, path.dirname(f.target), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).status, 'ABSTAIN');
  assert.equal(Object.values(readPredictionPairs(f.graph)).filter(pair => pair.outcome).length, 0);
});

test('replacing the real parent directory invalidates the creation binding', t => {
  const f = environment(t); const pending = beginObservation(f); assert.ok(pending);
  fs.renameSync(f.root, path.join(f.directory, 'original'));
  fs.mkdirSync(path.dirname(f.target), { recursive: true }); fs.writeFileSync(f.target, f.content);
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).status, 'ABSTAIN');
});

test('distinct large directory identities cannot collapse into the same creation anchor', t => {
  const f = environment(t);
  const original = fs.lstatSync;
  let identity = 9007199254740992n;
  fs.lstatSync = (file, options) => {
    const stat = original(file, options);
    if (file === f.root) Object.defineProperty(stat, 'ino', {
      value: options?.bigint ? identity : Number(identity), configurable: true,
    });
    return stat;
  };
  try {
    const pending = beginObservation(f); assert.ok(pending);
    assert.doesNotThrow(() => JSON.stringify(pending));
    identity += 1n;
    fs.mkdirSync(path.dirname(f.target)); fs.writeFileSync(f.target, f.content);
    assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).status, 'ABSTAIN');
  } finally { fs.lstatSync = original; }
});

test('denial, rollback and unreadable output do not become observed successes', t => {
  for (const scenario of ['denied', 'rollback', 'directory']) {
    const f = environment(t); const pending = beginObservation(f); assert.ok(pending);
    fs.mkdirSync(path.dirname(f.target));
    if (scenario === 'directory') fs.mkdirSync(f.target);
    else fs.writeFileSync(f.target, f.content);
    if (scenario === 'rollback') fs.unlinkSync(f.target);
    const result = finishObservation({ ...f, pending, report: { status: scenario === 'denied' ? 'blocked' : 'failed' } });
    assert.equal(result.status, 'ABSTAIN', scenario);
    assert.equal(Object.values(readPredictionPairs(f.graph)).filter(pair => pair.outcome).length, 0);
  }
});

function projectEpisode(t, observe) {
  const f = environment(t);
  const KernelV2 = require('../kernel.v2');
  const AgentV3 = require('../agent.v3');
  const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
  const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
  const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
  const { buildAgentCoderAction, createAgentCoderExecution } = require('../lib/agent-coder-execution');
  const { openJournalConnection } = require('../lib/experience/journal-connection');
  const { createExperienceJournal } = require('../lib/experience/journal');
  const sourceRoot = path.join(f.directory, 'source'); fs.mkdirSync(sourceRoot);
  const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init', '-b', 'feature/project'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'source'); git('add', 'seed.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const spec = { kind: 'project_spec', name: 'double-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/double', compute: { family: 'array-map', examples: [
      { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
    ], acceptanceExamples: [{ input: [-3, 8], expected: [-6, 16] }, { input: [7], expected: [14] },
      { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] };
  const memoryPath = path.join(f.directory, 'kernel.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  const connection = openJournalConnection({ dbPath: path.join(f.directory, 'journal.db') });
  const journal = createExperienceJournal({ store: connection });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: action.workspaceId,
      authorityRef: 'workspace-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role,
    } }) });
  const nextRoot = path.join(f.directory, 'next'); fs.mkdirSync(nextRoot);
  const queue = [f.root, nextRoot].map((targetRoot, index) => {
    const task = { id: index ? 'next' : 'first', operation: { type: 'initialize_project', targetRoot, spec,
      ...(index ? {} : { projectMemory: path.join(f.directory, 'method.json') }) } };
    const action = buildAgentCoderAction({ root: sourceRoot, task, goal: f.state.goal, workspaceId: 'default',
      policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION, journal });
    const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: {},
      reason: 'approve isolated project and method path', evidenceDigest: created.case.evidenceDigest }).ok, true);
    return { root: sourceRoot, task, goal: f.state.goal, action, caseId: created.case.caseId,
      approvalRuntime, requesterContext: {}, journal };
  });
  const { produceProject } = require('../lib/coder/project-producer');
  const logic = produceProject(spec).task.operation.steps.find(step => step.path === 'src/logic.js').content;
  const expectedDigest = createHash('sha256').update(logic).digest('hex');
  // Fill the existing summary window with actual approved HTTP-tested projects.
  for (let index = 0; index < DEFAULT_SUMMARY_WINDOW - 1; index++) {
    const targetRoot = path.join(f.directory, `history-${index}`); fs.mkdirSync(targetRoot);
    const task = { id: `history-${index}`, operation: { type: 'initialize_project', targetRoot, spec } };
    const action = buildAgentCoderAction({ root: sourceRoot, task, goal: f.state.goal, workspaceId: 'default',
      policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION, journal });
    const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
    assert.equal(created.ok, true);
    assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: {},
      reason: 'approve measured history project', evidenceDigest: created.case.evidenceDigest }).ok, true);
    const adapter = createAgentCoderExecution({ root: sourceRoot, task, goal: f.state.goal, action,
      caseId: created.case.caseId, approvalRuntime, requesterContext: {}, journal });
    const step = adapter.plan(f.state.goal, 'default')[0];
    const args = { state: f.state, step, graph: kernel.graph, opts: { ...f.opts,
      cognitionFileExpectations: { [step.id]: { workspaceId: 'default', path: path.join(targetRoot, 'src/logic.js'),
        sourceGroup: 'repeated-project-fixture', expectedDigest, riskScore: 0 } } } };
    const pending = beginObservation(args); assert.ok(pending);
    const executed = adapter.execute({ step, state: f.state });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(executed.data.attempts[0].test.exitCode, 0);
    assert.equal(finishObservation({ ...args, pending, report: { status: 'done' } }).outcome, 'confirmed');
  }
  const agent = new AgentV3({ kernel, dbPath: path.join(f.directory, 'agent.db'), dreamExperimentLoop: false,
    coderExecution: { queue }, timeBudgetMs: 60000 });
  try {
    const plan = agent.plan.bind(agent);
    agent.plan = (goal, opts) => {
      const result = plan(goal, opts);
      assert.deepEqual(result.data.steps.map(step => step.id), ['coder:first', 'coder:next']);
      result.data.objective = '';
      result.data.selectedTools = ['coder', 'verify'];
      result.data.steps.splice(1, 0, { id: 'safe-verify', tool: 'verify', action: 'verify', input: goal });
      return result;
    };
    const run = agent.run(f.state.goal, { resume: false, maxSteps: 2, maxIterations: 2,
      cognition: { predictionError: true, reward: true, value: true, percept: true, salience: true },
      cognitiveScheduler: { budget: 100, starvationWindow: 8 }, cognitionFrame: f.opts.cognitionFrame,
      cognitionFileExpectations: observe ? { 'coder:first': { workspaceId: 'default', path: f.target,
        sourceGroup: 'project-source', expectedDigest: '0'.repeat(64), riskScore: 0 } } : {} });
    assert.equal(run.data.steps[0].id, 'coder:first', JSON.stringify(run));
    assert.equal(run.data.steps[0].result.data.outcome, 'applied_tested');
    assert.equal(run.data.steps[0].result.data.projectMemory.state, 'remembered');
    assert.equal(git('status', '--porcelain'), '');
    return { ...f, memoryPath, run, pairs: readPredictionPairs(kernel.graph) };
  } finally { agent.storage.close(); connection.close(); }
}

test('real project creation observation feeds the next native AgentV3 choice and survives restart', t => {
  const candidate = projectEpisode(t, true);
  const control = projectEpisode(t, false);
  const trail = candidate.run.data.cognition.trail;
  assert.ok(trail.some(row => row.outcome === 'contradiction' && row.reason === 'artifact_digest_observed'));
  const selections = trail.filter(row => row.reason === 'salience_prepared');
  assert.equal(selections[0].values.find(row => row.key === CODER_KEY).nObserved, DEFAULT_SUMMARY_WINDOW - 1);
  assert.equal(selections[1].values.find(row => row.key === CODER_KEY).nObserved, DEFAULT_SUMMARY_WINDOW);
  assert.equal(selections[1].values.find(row => row.key === CODER_KEY).status, 'INSUFFICIENT');
  assert.equal(selections[1].values.find(row => row.key === CODER_KEY).arousal, null);
  assert.equal(control.run.data.cognition.trail.filter(row => row.reason === 'salience_prepared')[1]
    .values.find(row => row.key === CODER_KEY).nObserved, DEFAULT_SUMMARY_WINDOW - 1);
  assert.equal(candidate.run.data.steps[1].id, 'coder:next', JSON.stringify(candidate.run));
  assert.equal(control.run.data.steps[1].id, 'safe-verify', JSON.stringify(control.run));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const replayed = JSON.parse(execFileSync(process.execPath, ['-e',
    "const Graph=require('./graph');const {readPredictionPairs}=require('./lib/prediction-outcome-pairs');"
      + "const {prepareCognition}=require('./lib/agent-cognition-seam');const data=JSON.parse(process.argv[2]);"
      + "const g=new Graph({useSQLite:false,memoryPath:process.argv[1]});const before=readPredictionPairs(g);"
      + "const state={workspaceId:'default',observabilityRunId:'restart-choice',iteration:1,goal:data.goal};"
      + "const opts={cognition:{predictionError:true,reward:true,value:true,percept:true,salience:true},"
      + "cognitiveScheduler:{budget:100,starvationWindow:8},cognitionFrame:data.frame};"
      + "const result=prepareCognition({graph:g,state,queued:data.queued,opts,goal:data.goal,objective:''});"
      + "console.log(JSON.stringify({before,after:readPredictionPairs(g),result,order:data.queued.map(s=>s.id)}));",
    candidate.memoryPath, JSON.stringify({ goal: candidate.state.goal, frame: candidate.opts.cognitionFrame,
      queued: candidate.run.data.plan.steps.filter(step => step.id !== 'coder:first') })],
  { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  assert.deepEqual(replayed.before, candidate.pairs);
  assert.deepEqual(replayed.after, candidate.pairs);
  assert.deepEqual(replayed.order, ['coder:next', 'safe-verify']);
  assert.equal(replayed.result.values.find(row => row.key === CODER_KEY).nObserved, DEFAULT_SUMMARY_WINDOW);
});
