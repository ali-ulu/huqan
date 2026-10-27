'use strict';
const test = require('node:test');
// #4065 G1: Coder learning is keyed by the approved task's kind of work.
const CODER_KEY = 'risk:coder:initialize_project:array-map';
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
const { buildAgentCoderAction, createAgentCoderExecution } = require('../lib/agent-coder-execution');
const { createExperienceJournal } = require('../lib/experience/journal');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { beginObservation, finishObservation, expectationForStep } = require('../lib/agent-cognition-observation');
const { DEFAULT_SUMMARY_WINDOW } = require('../lib/cognition/prediction-error');

function environment(t, { fail = false, approve = true, shared = null } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-outcome-')));
  let agent, connection;
  const extraAgents = [];
  const closeJournal = () => { connection?.close(); connection = null; };
  t.after(() => { agent?.storage.close(); for (const extra of extraAgents) extra.storage.close();
    closeJournal(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sourceRoot = shared?.sourceRoot || path.join(directory, 'source');
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  if (shared) {
    for (const file of ['graph.json', 'graph.mutations.json', 'graph.embeddings.json', 'journal.db'])
      if (fs.existsSync(path.join(shared.directory, file)))
        fs.copyFileSync(path.join(shared.directory, file), path.join(directory, file));
  } else {
    fs.mkdirSync(sourceRoot); git('init', '-b', 'feature/outcome'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(sourceRoot, 'seed.txt'), 'source remains unchanged'); git('add', 'seed.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  }
  const spec = { kind: 'project_spec', name: 'double-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/double', compute: { family: 'array-map', examples: [
      { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
    ], acceptanceExamples: [{ input: [-3, 8], expected: [fail ? 999 : -6, 16] },
      { input: [7], expected: [14] }, { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] };
  const task = { id: 'project', operation: { type: 'initialize_project', targetRoot: root, spec } };
  const goal = 'create the approved double API'; const workspaceId = 'default';
  const kernel = new KernelV2({ noLoad: !shared, useSQLite: false, loadPlugins: false,
    memoryPath: path.join(directory, 'graph.json') });
  if (shared) assert.deepEqual(readPredictionPairs(kernel.graph), shared.pairs);
  connection = openJournalConnection({ dbPath: path.join(directory, 'journal.db') });
  let nativeJournal = createExperienceJournal({ store: connection });
  const reopenJournal = () => {
    connection = openJournalConnection({ dbPath: path.join(directory, 'journal.db') });
    nativeJournal = createExperienceJournal({ store: connection });
  };
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
  return { agent, journal, faults, captured, kernel, root, sourceRoot, goal, opts, git, directory, extraAgents,
    closeJournal, reopenJournal,
    spec, approvalRuntime, coderConfig: { root: sourceRoot, task, goal, action, approvalRuntime,
      requesterContext: {}, caseId: created.case.caseId, journal } };
}

function approvedProject(f, id) {
  const targetRoot = path.join(f.directory, id); fs.mkdirSync(targetRoot);
  const spec = structuredClone(f.spec);
  spec.routes[0].compute.acceptanceExamples[0].expected[0] = -6;
  const task = { id, operation: { type: 'initialize_project', targetRoot, spec } };
  const action = buildAgentCoderAction({ root: f.sourceRoot, task, goal: f.goal, workspaceId: 'default', journal: f.journal,
    policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const created = f.approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  assert.equal(f.approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: {},
    reason: 'approve exact comparison project', evidenceDigest: created.case.evidenceDigest }).ok, true);
  return { root: f.sourceRoot, task, goal: f.goal, action, caseId: created.case.caseId,
    approvalRuntime: f.approvalRuntime, requesterContext: {}, journal: f.journal };
}

function acceptanceHistory(t) {
  const f = environment(t);
  const run = f.agent.run(f.goal, f.opts);
  assert.equal(run.data.steps[0].result.data.attempts[0].test.exitCode, 0);
  const declaration = f.opts.cognitionCoderExpectations['coder:project'];
  // Repeated native projects fill the existing error window, not independent task support.
  for (let index = 1; index < DEFAULT_SUMMARY_WINDOW - 1; index++) {
    const coder = createAgentCoderExecution(approvedProject(f, `history-${index}`));
    const step = coder.plan(f.goal, 'default')[0];
    const state = { workspaceId: 'default', goal: f.goal, observabilityRunId: `history-${index}` };
    const args = { graph: f.kernel.graph, state, step, coder, opts: { ...f.opts,
      cognitionCoderExpectations: { [step.id]: declaration } } };
    const pending = beginObservation(args); assert.ok(pending);
    const result = coder.execute({ state, step });
    assert.equal(result.data.attempts[0].test.exitCode, 0);
    assert.equal(finishObservation({ ...args, pending, report: { status: 'done', result } }).outcome, 'confirmed');
  }
  f.closeJournal();
  return { ...f, run, pairs: readPredictionPairs(f.kernel.graph) };
}

function acceptanceEpisode(t, observe, shared) {
  const f = environment(t, { fail: true, shared });
  const next = approvedProject(f, 'next');
  const agent = new AgentV3({ kernel: f.kernel, dbPath: path.join(f.directory, 'episode.db'), dreamExperimentLoop: false,
    coderExecution: { queue: [f.coderConfig, next] }, timeBudgetMs: 60000 });
  f.extraAgents.push(agent);
  agent.baseAgent.plugins = { emit(event, data) {
    if (data.step?.id !== 'coder:project') return;
    if (event === 'beforeTask') Object.assign(f.captured, { state: data.state, step: data.step,
      pending: data.state.cognition?.pending });
    if (event === 'afterTask') f.captured.report = data.step;
  } };
  if (!observe) {
    const coder = agent.baseAgent.coderExecution;
    agent.baseAgent.coderExecution = { ...coder, observeAcceptance: () => null };
  }
  const plan = agent.plan.bind(agent);
  agent.plan = (goal, opts) => {
    const result = plan(goal, opts);
    assert.deepEqual(result.data.steps.map(step => step.id), ['coder:project', 'coder:next']);
    result.data.objective = ''; result.data.selectedTools = ['coder', 'verify'];
    result.data.steps.splice(1, 0, { id: 'safe-verify', tool: 'verify', action: 'verify', input: goal });
    return result;
  };
  const run = agent.run(f.goal, { ...f.opts, maxSteps: 2, maxIterations: 2 });
  assert.equal(run.data.steps[0].id, 'coder:project');
  assert.equal(run.data.steps[0].result.data.attempts[0].test.exitCode, 1);
  assert.equal(run.data.steps[0].result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.git('status', '--porcelain'), '');
  return { ...f, run, nextRoot: next.task.operation.targetRoot, pairs: readPredictionPairs(f.kernel.graph) };
}

test('native acceptance failure changes the next authorized choice and the choice survives restart', async t => {
  const history = acceptanceHistory(t);
  const files = ['graph.json', 'graph.mutations.json', 'journal.db'];
  const before = files.map(file => fs.readFileSync(path.join(history.directory, file)));
  const candidate = acceptanceEpisode(t, true, history);
  const control = acceptanceEpisode(t, false, history);
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(history.directory, file)), before[index]));
  const selections = f => f.run.data.cognition.trail.filter(row => row.reason === 'salience_prepared');
  const coderValue = row => row.values.find(value => value.key === CODER_KEY);
  assert.deepEqual(selections(candidate)[0].ranked, selections(control)[0].ranked);
  assert.deepEqual(selections(candidate)[0].values, selections(control)[0].values);
  assert.equal(coderValue(selections(candidate)[0]).nObserved, DEFAULT_SUMMARY_WINDOW - 1);
  assert.equal(coderValue(selections(candidate)[1]).nObserved, DEFAULT_SUMMARY_WINDOW);
  assert.equal(coderValue(selections(control)[1]).nObserved, DEFAULT_SUMMARY_WINDOW - 1);
  assert.ok(candidate.run.data.cognition.trail.some(row => row.reason === 'native_acceptance_observed'
    && row.outcome === 'contradiction'));
  assert.equal(candidate.run.data.steps[1].id, 'coder:next');
  assert.equal(candidate.run.data.steps[1].result.data.attempts[0].test.exitCode, 0);
  assert.equal(control.run.data.steps[1].id, 'safe-verify');
  assert.deepEqual(fs.readdirSync(control.nextRoot), []);
  assert.equal(coderValue(selections(candidate)[1]).nIndependent, 1);
  assert.equal(coderValue(selections(candidate)[1]).status, 'INSUFFICIENT');
  assert.equal(coderValue(selections(candidate)[1]).arousal, null);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const f of [candidate, control]) {
    const replayed = JSON.parse(execFileSync(process.execPath, ['-e',
      "const Graph=require('./graph');const {readPredictionPairs}=require('./lib/prediction-outcome-pairs');"
        + "const {prepareCognition}=require('./lib/agent-cognition-seam');const d=JSON.parse(process.argv[2]);"
        + "const g=new Graph({useSQLite:false,memoryPath:process.argv[1]});const before=readPredictionPairs(g);"
        + "const state={workspaceId:'default',observabilityRunId:'restarted',iteration:1,goal:d.goal};"
        + "const result=prepareCognition({state,graph:g,queued:d.queued,opts:d.opts,goal:d.goal,objective:''});"
        + "console.log(JSON.stringify({before,after:readPredictionPairs(g),result,order:d.queued.map(s=>s.id)}));",
      path.join(f.directory, 'graph.json'), JSON.stringify({ goal: f.goal,
        opts: { cognition: f.opts.cognition, cognitiveScheduler: f.opts.cognitiveScheduler, cognitionFrame: f.opts.cognitionFrame },
        queued: f.run.data.plan.steps.filter(step => step.id !== 'coder:project') })],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 15000 }));
    assert.deepEqual(replayed.before, f.pairs);
    assert.deepEqual(replayed.after, f.pairs);
    assert.equal(replayed.order[0], f.run.data.steps[1].id);
  }
  await t.test('failed native HTTP acceptance remains a contradiction despite fake reported success', () => {
    assertNativeFailure(candidate, candidate.run);
  });
  history.reopenJournal();
  await t.test('sealed native success rejects cloned, uncertain, corrupt and wrong-scope evidence', () => {
    assertNativeSuccess(history, history.run);
  });
});

function assertNativeSuccess(f, run) {
  assert.equal(run.data.steps[0].result.data.outcome, 'applied_tested');
  assert.equal(run.data.steps[0].result.data.attempts[0].test.exitCode, 0);
  const outcomes = Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome);
  assert.equal(outcomes.length, DEFAULT_SUMMARY_WINDOW - 1);
  assert.ok(outcomes.every(pair => pair.outcome.state === 'confirmed'));
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
  assert.equal(Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome).length, outcomes.length);
}

function assertNativeFailure(f, run) {
  const attempt = run.data.steps[0].result.data.attempts[0];
  assert.equal(attempt.test.exitCode, 1);
  assert.equal(attempt.rolledBack, true);
  assert.deepEqual(fs.readdirSync(f.root), []);
  const outcomes = Object.values(readPredictionPairs(f.kernel.graph)).filter(pair => pair.outcome);
  assert.equal(outcomes.length, DEFAULT_SUMMARY_WINDOW);
  assert.equal(outcomes.filter(pair => pair.outcome.state === 'contradiction').length, 1);
  f.captured.report.result.ok = true;
  assert.equal(finishObservation({ ...f.captured, graph: f.kernel.graph,
    coder: f.extraAgents[0].baseAgent.coderExecution }).outcome, 'contradiction');
}

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
