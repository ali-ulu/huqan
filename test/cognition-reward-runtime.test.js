'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Graph = require('../graph');
const { beginStepCognition, observeStepCognition } = require('../lib/agent-cognition-seam');
const { frameHashOf } = require('../lib/agent-cognition-observation');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'm8-runtime-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryPath = path.join(dir, 'graph.json');
  const target = path.join(dir, 'artifact.txt');
  fs.writeFileSync(target, 'expected');
  const state = { workspaceId: 'default', observabilityRunId: 'reward-run', goal: 'manifest dosyadir mi?' };
  const step = { id: 'observed', tool: 'ask', action: 'ask', input: state.goal };
  const opts = { cognition: { predictionError: true, reward: true, value: true, percept: true, salience: true },
    cognitiveScheduler: { budget: 100, starvationWindow: 8 },
    cognitionFrame: { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
      time: '2026-10-26T00:00:00Z', goal: state.goal, task: step.id },
    cognitionFileExpectations: { [step.id]: { workspaceId: 'default', path: target, sourceGroup: 'current-artifact',
      expectedDigest: createHash('sha256').update('expected').digest('hex'), riskScore: 0 } } };
  return { dir, memoryPath, target, state, step, opts, graph: new Graph({ useSQLite: false, memoryPath }) };
}

// Real file sensor and journal producer; groups are controlled fixtures, not a gain sample.
function history(f, id, content = 'unexpected', group = id, workspaceId = 'default', frame = f.opts.cognitionFrame) {
  const target = path.join(f.dir, `${id}.txt`); fs.writeFileSync(target, content);
  const state = { workspaceId, observabilityRunId: id, goal: f.state.goal };
  const step = { ...f.step, id };
  const opts = { ...f.opts, cognitionFrame: frame, cognitionFileExpectations: { [id]: {
    ...f.opts.cognitionFileExpectations[f.step.id], workspaceId, path: target, sourceGroup: group } } };
  const args = { ...f, state, step, opts };
  assert.ok(beginStepCognition(args));
  return observeStepCognition({ ...args, report: { status: 'done' } });
}

test('predecision expectation excludes later same-frame evidence and preserves source rows', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) assert.equal(history(f, `past-${i}`).outcome, 'contradiction');
  const sourceRows = f.graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  const pending = beginStepCognition(f); assert.ok(pending);
  for (let i = 0; i < 4; i++) history(f, `later-${i}`, 'expected');
  const result = observeStepCognition({ ...f, report: { status: 'done', ok: false } });
  assert.equal(result.reward.status, 'MEASURED');
  assert.equal(result.reward.reward, 1);
  assert.equal(result.reward.expected, -1);
  assert.equal(result.reward.rpe, 2);
  assert.equal(result.reward.expectedSource, 'value-ledger');
  assert.equal(result.rewardHistory.frameHash, frameHashOf(f.opts.cognitionFrame));
  assert.equal(result.rewardHistory.historyBoundary.decisionId, pending.decisionId);
  assert.equal(result.rewardHistory.historyBoundary.priorDecisionIds.length, 3);
  assert.ok(Object.isFrozen(result.rewardHistory.historyBoundary));
  const after = f.graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  assert.deepEqual(after.slice(0, sourceRows.length), sourceRows);
  const pairs = readPredictionPairs(f.graph);
  assert.equal(pairs[pending.decisionId].outcome.state, 'confirmed');
});

test('workspace/frame isolation and shared-source history retain the labeled prior', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    history(f, `foreign-${i}`, 'unexpected', `foreign-${i}`, 'other');
    history(f, `frame-${i}`, 'unexpected', `frame-${i}`, 'default', { ...f.opts.cognitionFrame, commit: 'other' });
    history(f, `shared-${i}`, 'unexpected', 'shared');
  }
  assert.ok(beginStepCognition(f));
  fs.writeFileSync(f.target, 'unexpected');
  const result = observeStepCognition({ ...f, report: { status: 'done', ok: true } });
  assert.equal(result.reward.expected, 0);
  assert.equal(result.reward.expectedSource, 'prior');
  assert.equal(result.reward.reward, -1);
  assert.equal(result.reward.rpe, -1);
});

test('reward opt-in works without the salience scheduler and absent opt-in stays off', t => {
  const f = fixture(t);
  f.opts.cognition = { predictionError: true, reward: true };
  delete f.opts.cognitiveScheduler;
  assert.ok(beginStepCognition(f));
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).reward.reward, 1);
  f.opts.cognition = undefined;
  const before = readPredictionPairs(f.graph);
  assert.equal(beginStepCognition(f), null);
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }), null);
  assert.deepEqual(readPredictionPairs(f.graph), before);
});

for (const mode of ['missing', 'forged', 'blocked', 'frame', 'history', 'family', 'graph']) test(`unbound or uncertain observation abstains (${mode})`, t => {
  const f = fixture(t);
  if (mode === 'history') f.graph.getCommittedMutationResultsByPrefix = () => null;
  const pending = beginStepCognition(f); assert.ok(pending);
  if (mode === 'missing') fs.rmSync(f.target);
  if (mode === 'forged') f.state.cognition.pending = structuredClone(pending);
  if (mode === 'frame') f.opts.cognitionFrame = { ...f.opts.cognitionFrame, commit: 'changed' };
  if (mode === 'family') f.step.tool = 'compare';
  if (mode === 'graph') f.graph = new Graph({ useSQLite: false, memoryPath: path.join(f.dir, 'other.json') });
  const result = observeStepCognition({ ...f, report: { status: mode === 'blocked' ? 'blocked' : 'done', ok: true } });
  assert.equal(result.reward.status, 'ABSTAIN');
  assert.notEqual(result.reward.reward, 1);
});

test('a consumed or copied pending observation cannot emit another reward', t => {
  const f = fixture(t); const pending = beginStepCognition(f);
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).reward.status, 'MEASURED');
  f.state.cognition.pending = pending;
  const replay = observeStepCognition({ ...f, report: { status: 'done' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.reward.status, 'ABSTAIN');
});

test('fresh process reads the same prior history without altering it', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) history(f, `restart-${i}`);
  const before = f.graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  const child = spawnSync(process.execPath, ['-e',
    "const fs=require('node:fs'),Graph=require('./graph');const {beginStepCognition,observeStepCognition}=require('./lib/agent-cognition-seam');const f=JSON.parse(process.argv[1]);f.graph=new Graph({useSQLite:false,memoryPath:f.memoryPath});beginStepCognition(f);console.log(JSON.stringify(observeStepCognition({...f,report:{status:'done'}})));",
    JSON.stringify({ memoryPath: f.memoryPath, state: f.state, step: f.step, opts: f.opts })],
  { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.reward.expected, -1);
  assert.equal(result.reward.rpe, 2);
  const reopened = new Graph({ useSQLite: false, memoryPath: f.memoryPath });
  assert.deepEqual(reopened.getCommittedMutationResultsByPrefix('prediction-outcome:').slice(0, before.length), before);
});

test('real AgentV3 loop exposes the sensor-bound reward and default remains off', t => {
  const f = fixture(t);
  const Kernel = require('../kernel');
  const KernelV2 = require('../kernel.v2');
  const AgentV3 = require('../agent.v3');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: f.memoryPath });
  kernel.learn('manifest dosyadir', Kernel.createAdmissionBypassOpts('m8-fixture'));
  const agent = new AgentV3({ kernel, dbPath: path.join(f.dir, 'agent.db'), dreamExperimentLoop: false, timeBudgetMs: 15000 });
  try {
  const plan = agent.plan.bind(agent);
  agent.plan = (goal, opts) => {
    const result = plan(goal, opts); result.data.objective = '';
    result.data.selectedTools = ['ask']; result.data.steps = [f.step]; return result;
  };
  const off = agent.run(f.state.goal, { ...f.opts, cognition: undefined, resume: false, maxSteps: 1, maxIterations: 1 });
  assert.ok(!off.data.cognition?.trail?.some(row => row.reward));
  const run = agent.run(f.state.goal, { ...f.opts, resume: false, maxSteps: 1, maxIterations: 1 });
  assert.equal(run.ok, true);
  const observed = run.data.cognition.trail.find(row => row.reason === 'artifact_digest_observed');
  assert.equal(observed.reward.status, 'MEASURED');
  assert.equal(observed.reward.reward, 1);
  assert.equal(observed.reward.rpe, 1);
  } finally { agent.storage.close(); }
});
