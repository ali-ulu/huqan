'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const flags = { percept: true, predictionError: true, reward: true, value: true, salience: true };

function installControls(payload, cost, scores) {
  const model = () => { cost.modelCalls++; throw new Error('M9_LAB_MODEL_FORBIDDEN'); };
  const Adapter = require('../llmAdapter');
  for (const method of ['ask', '_ollama', '_openai']) Adapter.prototype[method] = model;
  const network = () => { cost.networkAttempts++; throw new Error('M9_LAB_NETWORK_FORBIDDEN'); };
  globalThis.fetch = network;
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name); transport.request = network; transport.get = network;
  }
  const net = require('node:net'); net.connect = network; net.createConnection = network;
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    const exported = load.call(this, request, parent, isMain);
    if (parent?.filename === path.join(__dirname, 'agent-cognition-seam.js') && request === './cognition/salience') {
      return { ...exported, scoreSalience(input, options) {
        const before = clone(input);
        const used = payload.arm === 'arousalOff' ? { ...input, candidates: input.candidates.map(row => ({ ...row,
          arousal: Number.isFinite(row.arousal) ? 0 : row.arousal })) } : input;
        const result = exported.scoreSalience(used, options);
        scores.push({ before, used: clone(used), result: clone(result) });
        return result;
      } };
    }
    if (payload.scenario === 'observationOff' && parent?.filename === path.join(__dirname, '..', 'agent.v3.js')
        && request === './lib/agent-cognition-seam') return { ...exported, observeStepCognition() { return null; } };
    return exported;
  };
  return () => { Module._load = load; };
}

// Only domain output is exported. Neither the forecast nor result.ok can influence these bytes.
function project(report) {
  if (report.tool === 'verify' && ['verified', 'contradicted'].includes(report.result?.data?.status))
    return { status: report.result.data.status };
  if (report.tool === 'dream' && Array.isArray(report.result)) return { hypotheses: report.result };
  throw new Error('M9 fixture output is unavailable or unknown');
}

function runValueChild(payload) {
  const started = performance.now();
  const cost = { modelCalls: 0, networkAttempts: 0, executorEntries: 0 };
  const scores = [], exports = [], failures = [];
  const restore = installControls(payload, cost, scores);
  if (payload.guardProbe) {
    try {
      if (payload.guardProbe === 'model') new (require('../llmAdapter'))().ask('guard probe');
      else if (payload.guardProbe === 'network') globalThis.fetch('http://127.0.0.1/never-sent');
      else throw new Error('Unknown guard probe');
    } catch (error) { restore(); return { blocked: error.message === 'M9_LAB_MODEL_FORBIDDEN' || error.message === 'M9_LAB_NETWORK_FORBIDDEN', cost }; }
    throw new Error('M9 guard did not refuse');
  }
  let AgentV3;
  try { AgentV3 = require('../agent.v3'); } finally { restore(); }
  const KernelV2 = require('../kernel.v2');
  const HuqanStorage = require('../storage');
  const { readPredictionPairs, PAIR_OPERATION_PREFIX } = require('./prediction-outcome-pairs');
  const { readValueLedger } = require('./cognition-value-ledger-pairs');
  const { stableStringify } = require('./hash-chain');
  const directory = fs.realpathSync.native(payload.directory);
  const memoryPath = payload.training?.memoryPath || path.join(directory, 'memory.json');
  const workspaceId = 'm9-controlled-output';
  const goal = 'bounded output export';
  const sourceRoot = path.join(__dirname, '..');
  const frame = payload.training?.frame || { repo: sourceRoot,
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim(),
    environment: 'controlled-output-export', actor: 'fixture-host', time: new Date().toISOString(), goal, task: 'output-campaign' };
  const kernel = new KernelV2({ noLoad: !payload.training, useSQLite: false, loadPlugins: false, memoryPath });
  const pairRows = () => kernel.graph.getCommittedMutationResultsByPrefix(PAIR_OPERATION_PREFIX);
  const historyDigest = () => hash(stableStringify(pairRows()));
  const initialDigest = historyDigest();
  if (payload.training && initialDigest !== payload.training.historyDigest) throw new Error('M9 source prefix changed');
  const storage = new HuqanStorage({ kernel, memoryPath, dbPath: path.join(path.dirname(memoryPath), `${payload.arm || 'training'}.agent.db`) });
  const agent = new AgentV3({ kernel, storage, dreamExperimentLoop: false, maxSteps: 2 });
  const exportTargets = new Map();
  const exportOutput = (_event, data) => {
    if (_event !== 'afterTask') return;
    const report = data.step, target = exportTargets.get(report.id);
    if (!target) return;
    try {
      const projection = project(report), bytes = JSON.stringify(projection);
      fs.writeFileSync(target, bytes);
      const oracleOk = report.tool === 'verify' ? projection.status === 'verified'
        : projection.hypotheses.length === 0;
      exports.push({ id: report.id, family: report.tool, raw: clone(report.result), projection,
        artifactDigest: hash(fs.readFileSync(target)), oracleOk });
    } catch (error) { failures.push(error.message); fs.rmSync(target, { force: true }); }
  };
  agent.baseAgent.plugins = { emit: exportOutput };
  const execute = agent.baseAgent._executeStep.bind(agent.baseAgent);
  agent.baseAgent._executeStep = (...args) => { cost.executorEntries++; return execute(...args); };
  let fixtureSteps = [];
  const nativePlan = agent.plan.bind(agent);
  agent.plan = (text, opts) => {
    const plan = nativePlan(text, opts);
    if (!plan.ok) throw new Error('M9 fixture planning failed');
    plan.data.steps = clone(fixtureSteps); plan.data.selectedTools = [...new Set(fixtureSteps.map(step => step.tool))];
    plan.data.objective = '';
    return plan;
  };
  const common = { workspaceId, resume: false, maxSteps: 2, maxIterations: 1,
    cognition: flags, cognitiveScheduler: { budget: 100, starvationWindow: 8 }, cognitionFrame: frame,
    verifyOpts: { workspaceId }, dreamOpts: { workspaceId } };
  try {
    if (!payload.training) {
      // Frozen forecasts, not generated outcome labels. Mismatches are deliberate forecast errors.
      const forecasts = require('./cognition/contract').freezeResult({ verify: [{ status: 'verified' }, { status: 'verified' }, { status: 'contradicted' }],
        dream: [{ hypotheses: ['unexpected hypothesis'] }, { hypotheses: [] }, { hypotheses: [] }] });
      const count = payload.scenario === 'insufficient' ? 2 : 3;
      for (const family of ['verify', 'dream']) for (let index = 0; index < count; index++) {
        const id = `${family}-${index}`, target = path.join(directory, `${id}.output.json`);
        fs.writeFileSync(target, 'unproduced'); exportTargets.set(id, target);
        const expectedDigest = hash(JSON.stringify(forecasts[family][index]));
        fixtureSteps = [{ id, tool: family, action: family, input: family === 'verify' ? '2 > 1' : {} }];
        const run = agent.run(goal, { ...common, cognitionFileExpectations: { [id]: {
          workspaceId, path: target, expectedDigest, riskScore: 0,
          sourceGroup: payload.scenario === 'dependent' ? `shared-${family}` : `synthetic-artifact-${id}` } } });
        if (run.data?.steps[0]?.status !== 'done' || failures.length) throw new Error(`M9 actual output export failed: ${failures}`);
        exports[exports.length - 1].forecastDigest = expectedDigest;
      }
      const pairs = Object.values(readPredictionPairs(kernel.graph));
      const at = new Date().toISOString();
      const valueOptions = { workspaceId, asOf: at, historyBoundary: { at, decisionId: 'm9-next',
        priorDecisionIds: pairs.filter(pair => pair.outcome).map(pair => pair.decisionId) } };
      const value = readValueLedger(kernel.graph, valueOptions);
      if (cost.modelCalls || cost.networkAttempts) throw new Error('M9 training boundary violated');
      cost.elapsedMs = performance.now() - started;
      return { directory, memoryPath, frame, valueOptions, historyDigest: historyDigest(), value,
        outcomes: pairs.map(pair => pair.outcome?.state).filter(Boolean), exports, cost,
        chronology: pairRows().map(row => ({ committedAt: row.committedAt,
          at: row.result.prediction?.at || row.result.outcome?.at, decisionId: row.result.decisionId })),
        sourceGroups: 'synthetic artifact dependency groups, not independent real task samples' };
    }
    fixtureSteps = [{ id: 'next-verify', tool: 'verify', action: 'verify', input: '2 > 1' },
      { id: 'next-dream', tool: 'dream', action: 'dream', input: {} }];
    for (const step of fixtureSteps) {
      const target = path.join(directory, `${payload.arm}-${step.id}.output.json`);
      fs.writeFileSync(target, 'unproduced'); exportTargets.set(step.id, target);
    }
    const value = readValueLedger(kernel.graph, payload.training.valueOptions);
    const run = agent.run(goal, common);
    if (run.data?.steps.length !== 1 || failures.length || exports.length !== 1) throw new Error('M9 next real task did not execute');
    if (cost.modelCalls || cost.networkAttempts) throw new Error('M9 decision boundary violated');
    cost.elapsedMs = performance.now() - started;
    cost.maxRssBytes = process.resourceUsage().maxRSS * 1024;
    cost.memoryScope = 'this child only; no process-tree aggregate';
    return { step: { id: run.data.steps[0].id, tool: run.data.steps[0].tool, status: run.data.steps[0].status },
      output: exports[0], value, scorer: scores[0], historyDigest: initialDigest,
      historyUnchanged: historyDigest() === initialDigest, cost };
  } finally { storage.close(); }
}

module.exports = { runValueChild };
if (require.main === module) process.stdout.write(JSON.stringify(runValueChild(JSON.parse(process.argv[2]))));
