'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const permissions = require('../lib/coder/project-initialization-permission');
const { produceProject } = require('../lib/coder/project-producer');
const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
const { buildAgentCoderAction, createAgentCoderExecution } = require('../lib/agent-coder-execution');

const specOf = () => ({ kind: 'project_spec', name: 'doubles-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/double', compute: { family: 'array-map', examples: [
    { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
  ], acceptanceExamples: [{ input: [-3, 8], expected: [-6, 16] }, { input: [7], expected: [14] },
    { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] });

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-project-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = (directory, ...args) => execFileSync('git', args,
    { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  function repository(name) {
    const directory = path.join(base, name); fs.mkdirSync(directory);
    git(directory, 'init', '-b', 'feat/project');
    git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    git(directory, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(directory, 'seed.txt'), 'source stays unchanged');
    git(directory, 'add', 'seed.txt'); git(directory, 'commit', '-m', 'fixture');
    return directory;
  }
  const sourceRoot = repository('source');
  const root = path.join(base, 'target'); fs.mkdirSync(root);
  const source = { root: sourceRoot, branch: 'feat/project', head: git(sourceRoot, 'rev-parse', 'HEAD') };
  return { base, sourceRoot, root, source, repository, git, initialize: true, workspaceId: 'project-workspace' };
}

test('project fixture is a valid existing recipe with independent acceptance examples', () => {
  const produced = produceProject(specOf());
  assert.equal(produced.ok, true, JSON.stringify(produced));
});

test('project permission refuses an approval-bound source HEAD mismatch before writing', t => {
  const f = fixture(t);
  const result = permissions.createProjectInitializationPermission(specOf(), { ...f,
    sourceBinding: { ...f.source, head: '0'.repeat(40) } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PROJECT_SOURCE_CHANGED');
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), '');
});

test('project permission refuses a different approved recipe task digest', t => {
  const f = fixture(t);
  const result = permissions.createProjectInitializationPermission(specOf(), { ...f,
    taskBindingHash: '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PROJECT_TASK_CHANGED');
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('native project scope rejects an empty target inside another Git repository', t => {
  const f = fixture(t);
  const other = f.repository('other');
  const root = path.join(other, 'output'); fs.mkdirSync(root);
  assert.throws(() => permissions.inspectProjectInitializationScope({ root, sourceRoot: f.sourceRoot }),
    /PROJECT_TARGET_IN_REPOSITORY/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(f.git(other, 'status', '--porcelain'), '');
});

function approvedProject(t, { approve = true, spec = specOf(), journal, memory } = {}) {
  const f = fixture(t);
  const task = { id: 'initialize-doubles', operation: { type: 'initialize_project', targetRoot: f.root, spec,
    ...(memory ? { projectMemory: path.join(f.base, 'method.json') } : {}) } };
  const goal = 'Create the approved doubles API';
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(f.base, 'approval.json') });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph, ledger: createTrustEvidenceLedger({ graph }),
    resolveIdentity: ({ role, action }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: action.workspaceId,
      authorityRef: 'workspace-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role,
    } }) });
  const action = buildAgentCoderAction({ root: f.sourceRoot, task, goal, workspaceId: f.workspaceId, journal,
    policyVersion: 'policy-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true, JSON.stringify(created));
  const caseId = created.case.caseId;
  if (approve) assert.equal(approvalRuntime.decide({ caseId, decisionType: 'approve', approverContext: {},
    reason: 'approve exact project outputs', evidenceDigest: created.case.evidenceDigest }).ok, true);
  const config = { root: f.sourceRoot, task, goal, action, caseId, approvalRuntime, requesterContext: {}, journal };
  const adapter = createAgentCoderExecution(config);
  const state = { goal, workspaceId: f.workspaceId };
  const step = adapter.plan(goal, f.workspaceId)[0];
  assert.ok(step, 'closed project descriptor produces one native step');
  return { ...f, task, config, adapter, state, step, approvalRuntime, caseId };
}

test('approved native project executes independent HTTP acceptance and consumes its approval', t => {
  const f = approvedProject(t);
  assert.equal(f.step.input.target, f.root);
  assert.equal(f.config.action.target, f.root);
  assert.equal(f.adapter.prepare({ step: f.step, state: f.state }).ok, true);
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.outcome, 'applied_tested');
  assert.equal(result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'test/api.test.js')), true);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), '');
  assert.equal(f.approvalRuntime.getReviewCase(f.caseId).case.status, 'executed');
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
});

// Runs in a separate process with real journal persistence and native approvals.
function projectProcess({ sourceRoot, root, base, spec, mode }) {
  const { openJournalConnection } = require('./lib/experience/journal-connection');
  const { createExperienceJournal } = require('./lib/experience/journal');
  const Graph = require('./graph');
  const { createTrustEvidenceLedger } = require('./lib/trust-evidence-ledger');
  const { createHumanOversightApprovalRuntime } = require('./lib/human-oversight-approval-runtime');
  const { AGENT_ACTION_FIREWALL_VERSION } = require('./lib/agent-action-firewall');
  const { buildAgentCoderAction, createAgentCoderExecution } = require('./lib/agent-coder-execution');
  const path = require('node:path');
  const fs = require('node:fs');
  const connection = openJournalConnection({ dbPath: path.join(base, 'journal.db') });
  try {
    const persistedJournal = createExperienceJournal({ store: connection });
    const journal = mode === 'partial' ? { ...persistedJournal, append(event) {
      const result = persistedJournal.append(event);
      if (result.ok && event.type === 'run_closed')
        fs.writeFileSync(path.join(base, 'method.json'), 'occupied', { flag: 'wx' });
      return result;
    } } : persistedJournal;
    const graph = new Graph({ useSQLite: false, memoryPath: path.join(base, 'approvals.json') });
    const approvalRuntime = createHumanOversightApprovalRuntime({ graph, ledger: createTrustEvidenceLedger({ graph }),
      resolveIdentity: ({ role, action }) => ({ decision: 'allow', identity: {
        identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
        identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: action.workspaceId,
        authorityRef: 'workspace-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role,
      } }) });
    const memory = path.join(base, 'method.json');
    const goal = 'Create approved API'; const workspaceId = 'project-workspace';
    const task = { id: 'project-' + path.basename(root), operation: {
      type: 'initialize_project', targetRoot: root, spec, projectMemory: memory } };
    const action = buildAgentCoderAction({ root: sourceRoot, task, goal, workspaceId, journal,
      policyVersion: 'policy-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
    const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const caseId = created.case.caseId;
    const decision = approvalRuntime.decide({ caseId, decisionType: 'approve', approverContext: {},
      reason: 'approve project and exact method file', evidenceDigest: created.case.evidenceDigest });
    if (!decision.ok) throw new Error(JSON.stringify(decision));
    const config = { root: sourceRoot, task, goal, action, caseId, approvalRuntime, requesterContext: {}, journal };
    let nextStep;
    let adapter = createAgentCoderExecution(config);
    if (mode === 'partial') {
      const nextRoot = path.join(base, 'next'); fs.mkdirSync(nextRoot);
      const nextTask = { ...task, id: 'next-project', operation: { ...task.operation, targetRoot: nextRoot } };
      const nextAction = buildAgentCoderAction({ root: sourceRoot, task: nextTask, goal, workspaceId, journal,
        policyVersion: 'policy-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
      const nextCase = approvalRuntime.createReviewCase({ action: nextAction, firewallDecision: 'review', requesterContext: {} });
      if (!nextCase.ok) throw new Error(JSON.stringify(nextCase));
      const approved = approvalRuntime.decide({ caseId: nextCase.case.caseId, decisionType: 'approve', approverContext: {},
        reason: 'approve separate next project', evidenceDigest: nextCase.case.evidenceDigest });
      if (!approved.ok) throw new Error(JSON.stringify(approved));
      adapter = createAgentCoderExecution({ queue: [config, { ...config, task: nextTask, action: nextAction,
        caseId: nextCase.case.caseId }] });
      nextStep = adapter.plan(goal, workspaceId)[1];
    }
    const state = { goal, workspaceId }; const step = adapter.plan(goal, workspaceId)[0];
    if (!step) throw new Error('PROJECT_PLAN_MISSING');
    if (mode === 'drift') fs.writeFileSync(memory, '{}');
    const result = adapter.execute({ step, state });
    return { result, status: approvalRuntime.getReviewCase(caseId).case.status,
      second: adapter.execute({ step, state }), ...(nextStep ? { next: adapter.execute({ step: nextStep, state }) } : {}) };
  } finally { connection.close(); }
}

test('native project remembers a sealed method and reuses it after a real process restart', t => {
  const f = fixture(t);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(f.base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const run = (root, mode) => JSON.parse(execFileSync(process.execPath,
    ['-e', `console.log(JSON.stringify((${projectProcess.toString()})(JSON.parse(process.argv[1]))))`,
      JSON.stringify({ sourceRoot: f.sourceRoot, root, base: f.base, spec: specOf(), mode })],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 90000 }));
  const cold = run(f.root);
  assert.equal(cold.result.ok, true, JSON.stringify(cold));
  assert.equal(cold.result.data.projectMemory.state, 'remembered');
  assert.equal(cold.status, 'executed');
  assert.equal(cold.second.ok, false);
  const file = path.join(f.base, 'method.json'); const bytes = fs.readFileSync(file, 'utf8');
  const warmRoot = path.join(f.base, 'warm'); fs.mkdirSync(warmRoot);
  const warm = run(warmRoot);
  assert.equal(warm.result.ok, true, JSON.stringify(warm));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.equal(warm.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const driftRoot = path.join(f.base, 'drift'); fs.mkdirSync(driftRoot);
  const drift = run(driftRoot, 'drift');
  assert.equal(drift.result.ok, false);
  assert.equal(drift.result.meta.blocked, true);
  assert.deepEqual(fs.readdirSync(driftRoot), []);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), '');
});

test('a real memory save collision is partial and stops the remaining approved project queue', t => {
  const f = fixture(t);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(f.base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const output = JSON.parse(execFileSync(process.execPath,
    ['-e', `console.log(JSON.stringify((${projectProcess.toString()})(JSON.parse(process.argv[1]))))`,
      JSON.stringify({ sourceRoot: f.sourceRoot, root: f.root, base: f.base, spec: specOf(), mode: 'partial' })],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 90000 }));
  assert.equal(output.result.ok, false, JSON.stringify(output));
  assert.equal(output.result.data.outcome, 'partial');
  assert.equal(output.result.data.projectMemory.reason, 'EEXIST');
  assert.equal(output.result.meta.uncertain, true);
  assert.equal(output.result.meta.blocked, false);
  assert.equal(output.next.ok, false);
  assert.equal(output.next.meta.uncertain, true);
  assert.deepEqual(fs.readdirSync(path.join(f.base, 'next')), []);
  assert.equal(fs.readFileSync(path.join(f.base, 'method.json'), 'utf8'), 'occupied');
  assert.equal(fs.existsSync(path.join(f.root, 'test/api.test.js')), true);
});

test('project descriptor cannot authorize itself or survive target drift', t => {
  const denied = approvedProject(t, { approve: false });
  denied.task.authorized = true;
  assert.equal(denied.adapter.execute({ step: denied.step, state: denied.state }).ok, false);
  assert.deepEqual(fs.readdirSync(denied.root), []);
  const drifted = approvedProject(t);
  fs.writeFileSync(path.join(drifted.root, 'foreign.txt'), 'preserve');
  assert.equal(drifted.adapter.prepare({ step: drifted.step, state: drifted.state }).ok, false);
  assert.equal(drifted.adapter.execute({ step: drifted.step, state: drifted.state }).ok, false);
  assert.equal(fs.readFileSync(path.join(drifted.root, 'foreign.txt'), 'utf8'), 'preserve');
});

test('failed independent project acceptance rolls back every generated file', t => {
  const spec = specOf(); spec.routes[0].compute.acceptanceExamples[0].expected[0] = 999;
  const f = approvedProject(t, { spec });
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, false);
  assert.equal(result.data.attempts[0].test.exitCode, 1);
  assert.equal(result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), '');
  assert.equal(f.adapter.execute({ step: f.step, state: f.state }).ok, false);
});

test('AgentV3 runs the approved project through its real Coder step', t => {
  const f = approvedProject(t);
  const KernelV2 = require('../kernel.v2');
  const AgentV3 = require('../agent.v3');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false,
    memoryPath: path.join(f.base, 'kernel.json') });
  const agent = new AgentV3({ kernel, dbPath: path.join(f.base, 'agent.db'), dreamExperimentLoop: false,
    coderExecution: f.config });
  try {
    const run = agent.run(f.state.goal, { workspaceId: f.workspaceId, resume: false, maxIterations: 1, maxSteps: 1 });
    assert.equal(run.data.steps[0].tool, 'coder', JSON.stringify(run));
    assert.equal(run.data.steps[0].status, 'done', JSON.stringify(run));
    assert.equal(run.data.steps[0].result.data.outcome, 'applied_tested');
    assert.equal(run.data.steps[0].result.data.attempts[0].test.exitCode, 0);
    assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), '');
  } finally { agent.storage.close(); }
});

test('project scope rejects executable properties, proxies and executor options without invoking them', t => {
  const f = fixture(t);
  const build = task => buildAgentCoderAction({ root: f.sourceRoot, task, goal: 'project', workspaceId: f.workspaceId,
    policyVersion: 'policy-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const task = { id: 'unsafe', operation: { type: 'initialize_project', targetRoot: f.root, spec: specOf() } };
  let calls = 0;
  const getter = { ...task, operation: { ...task.operation } };
  Object.defineProperty(getter.operation, 'spec', { enumerable: true, get() { calls++; return specOf(); } });
  assert.throws(() => build(getter));
  assert.throws(() => build(new Proxy(task, { get() { calls++; throw new Error('proxy invoked'); } })));
  for (const field of ['authorized', 'journal', 'test', 'candidates'])
    assert.throws(() => build({ ...task, [field]: true }));
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('project freezes nested spec data and refuses a changed source HEAD', t => {
  const f = approvedProject(t);
  f.task.operation.spec.routes[0].compute.acceptanceExamples[0].expected[0] = 999;
  assert.equal(f.adapter.prepare({ step: f.step, state: f.state }).ok, true);
  f.git(f.sourceRoot, 'commit', '--allow-empty', '-m', 'head changed');
  const result = f.adapter.execute({ step: f.step, state: f.state });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CODER_REPOSITORY_CHANGED');
  assert.deepEqual(fs.readdirSync(f.root), []);
});
