'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
const { buildAgentCoderAction } = require('../lib/agent-coder-execution');
const { createExperienceJournal } = require('../lib/experience/journal');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { finishObservation, expectationForStep } = require('../lib/agent-cognition-observation');

function environment(t, { fail = false, approve = true } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-outcome-')));
  let agent, connection;
  t.after(() => { agent?.storage.close(); connection?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sourceRoot = path.join(directory, 'source'); fs.mkdirSync(sourceRoot);
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init', '-b', 'feature/outcome'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'source remains unchanged'); git('add', 'seed.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const spec = { kind: 'project_spec', name: 'double-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/double', compute: { family: 'array-map', examples: [
      { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
    ], acceptanceExamples: [{ input: [-3, 8], expected: [fail ? 999 : -6, 16] },
      { input: [7], expected: [14] }, { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] };
  const task = { id: 'project', operation: { type: 'initialize_project', targetRoot: root, spec } };
  const goal = 'create the approved double API'; const workspaceId = 'default';
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false,
    memoryPath: path.join(directory, 'graph.json') });
  connection = openJournalConnection({ dbPath: path.join(directory, 'journal.db') });
  const nativeJournal = createExperienceJournal({ store: connection });
  const faults = { read: rows => rows, manifest: value => value };
  const journal = { ...nativeJournal,
    read(...args) { return faults.read(nativeJournal.read(...args)); },
    manifest(...args) { return faults.manifest(nativeJournal.manifest(...args)); } };
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      authorityRef: 'fixture-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role,
    } }) });
  const action = buildAgentCoderAction({ root: sourceRoot, task, goal, workspaceId, journal,
    policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (approve) assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve',
    approverContext: {}, reason: 'approve exact project and independent acceptance', evidenceDigest: created.case.evidenceDigest }).ok, true);
  agent = new AgentV3({ kernel, dbPath: path.join(directory, 'agent.db'), dreamExperimentLoop: false,
    coderExecution: { root: sourceRoot, task, goal, action, approvalRuntime, requesterContext: {},
      caseId: created.case.caseId, journal } });
  const captured = {};
  agent.baseAgent.plugins = { emit(event, data) {
    if (event === 'beforeTask') Object.assign(captured, { state: data.state, step: data.step,
      pending: data.state.cognition?.pending });
    if (event === 'afterTask') captured.report = data.step;
  } };
  const opts = { resume: false, maxSteps: 1, maxIterations: 1,
    cognition: { percept: true, predictionError: true, reward: true, value: true, salience: true },
    cognitiveScheduler: { budget: 100, starvationWindow: 8 },
    cognitionFrame: { repo: sourceRoot, branch: action.args.branch, commit: action.args.head,
      environment: 'test', actor: 'operator', time: '2026-10-25T00:00:00Z', goal, task: task.id },
    cognitionCoderExpectations: { 'coder:project': { workspaceId, expected: 'passed',
      sourceGroup: 'native-project-acceptance', riskScore: 0 } } };
  return { agent, journal, faults, captured, kernel, root, sourceRoot, goal, opts, git };
}

test('a sealed native HTTP acceptance pass becomes a scoped observed outcome', t => {
  const f = environment(t); const run = f.agent.run(f.goal, f.opts);
  assert.equal(run.data.steps[0].result.data.outcome, 'applied_tested');
  assert.equal(run.data.steps[0].result.data.attempts[0].test.exitCode, 0);
  const outcomes = Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome);
  assert.equal(outcomes.length, 1, 'native journal proof must reach cognition without a file-digest expectation');
  assert.equal(outcomes[0].outcome.state, 'confirmed');
  assert.equal(f.git('status', '--porcelain'), '');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const persisted = JSON.parse(execFileSync(process.execPath, ['-e',
    "const Graph=require('./graph');const {readPredictionPairs}=require('./lib/prediction-outcome-pairs');"
      + "const g=new Graph({useSQLite:false,memoryPath:process.argv[1]});console.log(JSON.stringify(readPredictionPairs(g)));",
    path.join(f.sourceRoot, '..', 'graph.json')],
  { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  assert.deepEqual(persisted, readPredictionPairs(f.kernel.graph), 'a fresh process reads the same scoped outcome');
  const args = { ...f.captured, graph: f.kernel.graph, coder: f.agent.baseAgent.coderExecution };
  assert.equal(finishObservation(args).replayed, true);
  args.report.result.meta.uncertain = true;
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  delete args.report.result.meta.uncertain;
  const originalOutcome = args.report.result.data.outcome;
  args.report.result.data.outcome = 'partial';
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  args.report.result.data.outcome = originalOutcome;
  assert.equal(finishObservation({ ...args, report: JSON.parse(JSON.stringify(args.report)) }).status, 'ABSTAIN');
  assert.equal(finishObservation({ ...args, state: { ...args.state, workspaceId: 'other' } }).status, 'ABSTAIN');
  assert.equal(finishObservation({ ...args, pending: { ...args.pending,
    descriptor: { ...args.pending.descriptor, ticketId: 'forged' } } }).status, 'ABSTAIN');
  assert.equal(finishObservation({ ...args, pending: { ...args.pending, decisionId: 'other' } }).status, 'ABSTAIN');
  f.faults.manifest = value => ({ ...value, closed: false });
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  f.faults.manifest = value => value;
  for (const patch of [{ ran: false }, { signal: 'SIGTERM' }, { reason: 'TEST_TIMEOUT' }, { exitCode: null }]) {
    f.faults.read = rows => rows.map(row => row.type === 'run_closed' ? { ...row,
      payload: { ...row.payload, evidence: { ...row.payload.evidence,
        test: { ...row.payload.evidence.test, ...patch } } } } : row);
    assert.equal(finishObservation(args).status, 'ABSTAIN', JSON.stringify(patch));
  }
  f.faults.read = () => { throw Object.assign(new Error('corrupt'), { code: 'INTEGRITY_MISMATCH' }); };
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  f.faults.read = () => [];
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  f.faults.read = rows => rows;
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'new head');
  assert.equal(finishObservation(args).status, 'ABSTAIN');
  assert.equal(Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome).length, 1);
});

test('failed native HTTP acceptance with verified rollback is observed as a test failure', t => {
  const f = environment(t, { fail: true }); const run = f.agent.run(f.goal, f.opts);
  const attempt = run.data.steps[0].result.data.attempts[0];
  assert.equal(attempt.test.exitCode, 1);
  assert.equal(attempt.rolledBack, true);
  assert.deepEqual(fs.readdirSync(f.root), []);
  const outcomes = Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome);
  assert.equal(outcomes.length, 1, 'native acceptance failure is distinct from absent artifact evidence');
  assert.equal(outcomes[0].outcome.state, 'contradiction');
  f.captured.report.result.ok = true;
  assert.equal(finishObservation({ ...f.captured, graph: f.kernel.graph,
    coder: f.agent.baseAgent.coderExecution }).outcome, 'contradiction');
});

test('denied approval and fake reported success produce no observed outcome', t => {
  const f = environment(t, { approve: false });
  const emit = f.agent.baseAgent.plugins.emit;
  f.agent.baseAgent.plugins.emit = (event, data) => {
    emit(event, data);
    if (event === 'afterTask') { data.step.result.ok = true; data.step.status = 'done'; }
  };
  f.agent.run(f.goal, f.opts);
  assert.equal(Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome).length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('ambiguous and wrong-frame declarations cannot arm native observation', t => {
  const f = environment(t);
  const coder = f.agent.baseAgent.coderExecution;
  const state = { workspaceId: 'default', goal: f.goal, observabilityRunId: 'declaration-check' };
  const step = coder.plan(f.goal, 'default')[0];
  const opts = { ...f.opts, cognitionFileExpectations: { [step.id]: {} } };
  assert.equal(expectationForStep({ state, step, opts, coder }), null);
  delete opts.cognitionFileExpectations;
  opts.cognitionFrame = { ...opts.cognitionFrame, commit: 'wrong-head' };
  assert.equal(expectationForStep({ state, step, opts, coder }), null);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
