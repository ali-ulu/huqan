'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const hash = value => createHash('sha256').update(value).digest('hex');
const originalSource = 'module.exports = n => n + 1;\n';
const expectedSource = 'module.exports = n => ((n * 3) - 2);\n';

function installModelGuard(cost) {
  const refuseModel = () => { cost.modelCalls++; throw new Error('M7_MODEL_FORBIDDEN'); };
  const LLMAdapter = require('../llmAdapter');
  for (const method of ['ask', '_ollama', '_openai']) LLMAdapter.prototype[method] = refuseModel;
  const refuseNetwork = () => { cost.networkAttempts++; throw new Error('M7_NETWORK_FORBIDDEN'); };
  globalThis.fetch = refuseNetwork;
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name); transport.request = refuseNetwork; transport.get = refuseNetwork;
  }
  const net = require('node:net'); net.connect = refuseNetwork; net.createConnection = refuseNetwork;
}

function installUrgencyArm(arm, inputs, directory, workspaceId) {
  function normalize(value, key = '', owner = '') {
    // Derived scope digests change with each isolated workspace, not with treatment.
    if (['observabilityRunId', 'traceId', 'agentId', 'startedAt', 'createdAt', 'updatedAt', 'time',
      'goalScopeId', 'checkpointId', 'resumeToken', 'baselineHash'].includes(key)
      || (key === 'hash' && owner === 'behavioralManifest')
      || (key === 'fingerprint' && owner === 'executionScope')
      || (key === 'commit' && owner === 'cognitionFrame')) return '<isolated-id-or-clock>';
    if (typeof value === 'string') return value.replaceAll(directory, '<arm-directory>').replaceAll(workspaceId, '<workspace>');
    if (Array.isArray(value)) return value.map(item => normalize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, normalize(item, field, key)]));
    return value;
  }
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    const exported = load.call(this, request, parent, isMain);
    if (parent?.filename === path.join(__dirname, 'agent-cognition-seam.js') && request === './agent-step-progression') {
      return { ...exported, scheduleQueuedSteps(args) {
        const before = normalize(JSON.parse(JSON.stringify(args)));
        // Lab-only intervention: all source scoring, sensing and history still run.
        if (arm === 'control') for (const step of args.queued) step.urgency = 0;
        const used = normalize(JSON.parse(JSON.stringify(args)));
        const exceptUrgency = structuredClone(used);
        exceptUrgency.queued = exceptUrgency.queued.map(({ urgency, ...step }) => step);
        inputs.push({ before, used, exceptUrgency });
        return exported.scheduleQueuedSteps(args);
      } };
    }
    return exported;
  };
  return () => { Module._load = load; };
}

function replay({ memoryPath, journalPath, valueOptions }) {
  const guard = { modelCalls: 0, networkAttempts: 0 }; installModelGuard(guard);
  const Graph = require('../graph');
  const { readPredictionPairs } = require('./prediction-outcome-pairs');
  const before = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : Buffer.alloc(0);
  const graph = new Graph({ useSQLite: false, memoryPath });
  const pairs = readPredictionPairs(graph);
  const value = require('./cognition-value-ledger-pairs').readValueLedger(graph, valueOptions);
  const after = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : Buffer.alloc(0);
  if (guard.modelCalls || guard.networkAttempts) throw new Error('M7 replay model-free boundary violated');
  return { pairs, value, journalUnchanged: before.equals(after), ...guard, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
}

function runArm({ arm, scenario, directory }) {
  if (!['control', 'candidate'].includes(arm) || !['repair', 'denied', 'rollback'].includes(scenario))
    throw new TypeError('Invalid M7 arm');
  const started = performance.now();
  // Windows CI may pass an 8.3 TEMP path; normalize before binding either arm.
  fs.mkdirSync(directory, { recursive: true }); directory = fs.realpathSync.native(directory);
  const cost = { modelCalls: 0, networkAttempts: 0, executorEntries: 0, nativeTestCalls: 0, oracleCalls: 0 };
  installModelGuard(cost);
  const schedulerInputs = [];
  const workspaceId = `m7-${arm}`;
  const restoreLoader = installUrgencyArm(arm, schedulerInputs, directory, workspaceId);
  const subprocess = require('node:child_process');
  const actualSpawn = subprocess.spawnSync;
  subprocess.spawnSync = (command, args, options) => {
    if (command === 'node' && args?.[0] === 'check.js') cost.nativeTestCalls++;
    return actualSpawn(command, args, options);
  };
  let AgentV3;
  try { AgentV3 = require('../agent.v3'); } finally { restoreLoader(); }
  const KernelV2 = require('../kernel.v2');
  const { buildAgentCoderAction } = require('./agent-coder-execution');
  const { createTrustEvidenceLedger } = require('./trust-evidence-ledger');
  const { createHumanOversightApprovalRuntime } = require('./human-oversight-approval-runtime');
  const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
  const { readPredictionPairs } = require('./prediction-outcome-pairs');
  const root = path.join(directory, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  git('init', '-b', 'feat/m7-pilot');
  git('config', 'user.name', 'M7 Pilot'); git('config', 'user.email', 'pilot@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'value.js'), originalSource);
  fs.writeFileSync(path.join(root, 'check.js'), scenario === 'rollback'
    ? "require('node:assert/strict').equal(require('./value')(5),999);\n"
    : "const a=require('node:assert/strict'),f=require('./value');a.equal(f(5),13);a.equal(f(8),22);\n");
  git('add', '.'); git('commit', '-m', 'isolated M7 pilot fixture');
  const task = { id: 'affine-repair', level: 'l0', allowedPaths: ['value.js'],
    operation: { type: 'replace_text', path: 'value.js' }, test: { command: 'node check.js' },
    synthesis: { family: 'affine-integer', examples: [
      { input: 0, expected: -2 }, { input: 1, expected: 1 }, { input: 3, expected: 7 } ] } };
  const goal = 'repair value';
  const memoryPath = path.join(directory, 'memory.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  const action = buildAgentCoderAction({ root, task, goal, workspaceId,
    policyVersion: 'm7-pilot-policy', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'agent-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      agentId: role === 'requester' ? 'coder' : '', ownerActorId: role, authorityRef: 'pilot-fixture-owner' } }) });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  if (!created.ok) throw new Error(`M7 case failed: ${created.reason}`);
  if (scenario !== 'denied') {
    const approved = approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve',
      approverContext: {}, reason: 'pilot operator approves exact isolated task', evidenceDigest: created.case.evidenceDigest });
    if (!approved.ok) throw new Error(`M7 approval failed: ${approved.reason}`);
  }
  const agent = new AgentV3({ kernel, dbPath: path.join(directory, 'agent.db'), dreamExperimentLoop: false,
    coderExecution: { root, task, goal, action, approvalRuntime, requesterContext: {}, caseId: created.case.caseId } });
  try {
    let nativeStepPreserved = false;
    const execute = agent.baseAgent._executeStep.bind(agent.baseAgent);
    agent.baseAgent._executeStep = (...args) => { cost.executorEntries++; return execute(...args); };
    const nativePlan = agent.plan.bind(agent);
    agent.plan = (text, opts) => {
      const plan = nativePlan(text, opts);
      if (!plan.ok || plan.data.steps.length !== 1 || plan.data.steps[0].tool !== 'coder') throw new Error('M7 native plan changed');
      const nativeStep = plan.data.steps[0];
      if (scenario === 'repair') {
        plan.data.steps = [ { id: 'safe-read', tool: 'ask', action: 'ask', input: 'value nedir?' }, plan.data.steps[0] ];
        plan.data.selectedTools = ['ask', 'coder'];
      }
      nativeStepPreserved = plan.data.steps.includes(nativeStep);
      plan.data.objective = '';
      return plan;
    };
    const frame = { repo: root, branch: action.args.branch, commit: action.args.head,
      environment: 'pilot', actor: 'operator', time: new Date().toISOString(), goal, task: task.id };
    const run = agent.run(goal, { workspaceId, resume: false, maxSteps: 2, maxIterations: 1,
      cognition: { predictionError: true, reward: true, value: true, percept: true, salience: true },
      cognitiveScheduler: { budget: 100, starvationWindow: 8 }, cognitionFrame: frame,
      cognitionFileExpectations: { 'coder:affine-repair': { workspaceId, path: path.join(root, 'value.js'),
        sourceGroup: 'affine-source', expectedDigest: hash(expectedSource) } } });
    const reports = run.data.steps.map(step => ({ id: step.id, tool: step.tool, status: step.status, code: step.result?.error?.code }));
    const attempts = run.data.steps.flatMap(step => step.result?.data?.attempts || []);
    const source = fs.readFileSync(path.join(root, 'value.js'), 'utf8');
    // Held-out inputs differ from both synthesis examples and the declared Coder test.
    cost.oracleCalls++;
    const oracleProcess = spawnSync(process.execPath, ['-e',
      "const a=require('node:assert/strict'),f=require(process.argv[1]);for(const n of [-7,2,11])a.equal(f(n),3*n-2);", path.join(root, 'value.js')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (oracleProcess.error) throw oracleProcess.error;
    const pairs = readPredictionPairs(kernel.graph);
    const journalPath = kernel.graph.jsonJournalPath();
    const valueOptions = { workspaceId, asOf: new Date().toISOString(),
      historyBoundary: { at: new Date().toISOString(), decisionId: 'pilot-next', priorDecisionIds: Object.keys(pairs) } };
    valueOptions.historyBoundary.at = valueOptions.asOf;
    const value = require('./cognition-value-ledger-pairs').readValueLedger(kernel.graph, valueOptions);
    const reopenedProcess = spawnSync(process.execPath, [__filename, JSON.stringify({ mode: 'replay', memoryPath, journalPath, valueOptions })],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (reopenedProcess.error || reopenedProcess.status !== 0) throw new Error(`M7 replay failed: ${reopenedProcess.stderr}`);
    const reopened = JSON.parse(reopenedProcess.stdout);
    const approval = approvalRuntime.getReviewCase(created.case.caseId).case;
    let replayExecutions = 0;
    const approvalReplay = scenario === 'repair' && !source.includes('((n * 3) - 2)') ? null : approvalRuntime.executeApprovedSync({
      caseId: created.case.caseId, action, requesterContext: {},
      firewallRequest: { context: { branch: action.args.branch, repoState: { known: true, dirty: false } } },
      executor: () => { replayExecutions++; throw new Error('M7 approval must not execute twice'); } });
    cost.elapsedMs = performance.now() - started; cost.maxRssBytes = Math.max(process.resourceUsage().maxRSS * 1024, reopened.maxRssBytes);
    cost.memoryScope = 'maximum of observed AgentV3 runtime and fresh replay process RSS; not a process-tree total';
    cost.unmeasuredChildMemory = ['Git setup', 'native Coder acceptance command', 'independent oracle'];
    if (cost.modelCalls || cost.networkAttempts) throw new Error('M7 model-free boundary violated');
    return { root, workspaceId, reports, schedulerInputs, pairs, value, reopened,
      scopeBindings: { nativeStepPreserved, workspace: approval.workspaceId === workspaceId,
        target: approval.resourceRef === action.args.root, fingerprint: approval.actionFingerprint === action.actionFingerprint,
        head: git('rev-parse', 'HEAD') === action.args.head, frame: frame.repo === root && frame.commit === action.args.head },
      sources: Object.fromEntries(['cognitive-lab-m7-runtime.js', 'agent-coder-execution.js', 'agent-cognition-seam.js',
        'cognitive-scheduler.js'].map(file => [file, hash(fs.readFileSync(path.join(__dirname, file)))])),
      otherWorkspacePairs: kernel.graph.getCommittedMutationResultsByPrefix(require('./prediction-outcome-pairs').PAIR_OPERATION_PREFIX)
        .filter(row => row.result.workspaceId !== workspaceId).length,
      changed: source !== originalSource, sourceDigest: hash(source), initialDigest: hash(originalSource),
      rollbackVerified: attempts.some(attempt => attempt.rolledBack === true),
      approvalStatus: approval.status, executionOutcome: approval.executionOutcome,
      consumed: Boolean(approval.consumedAt), approvalReplay: { refused: approvalReplay?.ok === false, replayExecutions },
      oracle: { ok: oracleProcess.status === 0, exitCode: oracleProcess.status, inputs: [-7, 2, 11] },
      cognition: run.data.cognition, cost };
  } finally { agent.storage.close(); }
}

function dispatch(payload) {
  if (payload.mode === 'run') return runArm(payload);
  if (payload.mode === 'replay') return replay(payload);
  if (payload.mode === 'guard-probe') {
    const cost = { modelCalls: 0, networkAttempts: 0 }; installModelGuard(cost);
    try { new (require('../llmAdapter'))().ask('probe'); } catch (error) {
      return { blocked: error.message === 'M7_MODEL_FORBIDDEN', ...cost };
    }
    throw new Error('M7 model guard did not block');
  }
  throw new TypeError('Unknown M7 child mode');
}
module.exports = { dispatch };
if (require.main === module) process.stdout.write(JSON.stringify(dispatch(JSON.parse(process.argv[2]))));
