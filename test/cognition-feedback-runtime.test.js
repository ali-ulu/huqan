'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const { beginStepCognition, observeStepCognition, prepareCognition } = require('../lib/agent-cognition-seam');
const { readValueLedger } = require('../lib/cognition-value-ledger-pairs');
const { scheduleCandidates } = require('../lib/cognitive-scheduler');

const flags = { predictionError: true, reward: true, value: true, percept: true, salience: true };
const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-22T00:00:00Z', goal: 'manifest dosyadir mi?', task: 'digest-v1' };
const digest = createHash('sha256').update('expected artifact').digest('hex');
function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-runtime-'));
  const memoryPath = path.join(dir, 'graph.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  kernel.learn('manifest dosyadir', Kernel.createAdmissionBypassOpts('m7-fixture'));
  const agent = new AgentV3({ kernel, dbPath: path.join(dir, 'agent.db'), maxSteps: 3,
    maxIterations: 3, dreamExperimentLoop: false, timeBudgetMs: 15000 });
  t.after(() => { agent.storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const opts = { cognition: flags, cognitiveScheduler: { budget: 100, starvationWindow: 8 },
    cognitionFrame: frame, cognitionFileExpectations: {} };
  function expectation(stepId, group, content = 'expected artifact') {
    const target = path.join(dir, `${group}.json`); fs.writeFileSync(target, content);
    opts.cognitionFileExpectations[stepId] = { workspaceId: 'default', path: target,
      sourceGroup: group, expectedDigest: digest, riskScore: 0 };
  }
  // Real sensor + real journal producer; no fabricated outcome rows or reward injection.
  for (const family of ['ask', 'compare']) for (let i = 0; i < 5; i++) {
    const id = `${family}-${i}`; expectation(id, id);
    const state = { workspaceId: 'default', observabilityRunId: `source-${id}`, goal: frame.goal };
    const args = { state, opts, graph: kernel.graph, step: { id, tool: family } };
    assert.ok(beginStepCognition(args));
    assert.equal(observeStepCognition({ ...args, report: { status: 'done' } }).outcome, 'confirmed');
  }
  return { agent, opts, kernel, memoryPath, expectation };
}

test('AgentV3 consumes the independently observed outcome before its next eligible choice', t => {
  const f = environment(t); f.expectation('first', 'manifest-drift', 'unexpected artifact');
  const goal = frame.goal;
  const originalPlan = f.agent.plan.bind(f.agent);
  // Fixed plan fixture; the real AgentV3 loop, tools, kernel, gates and storage execute it.
  f.agent.plan = (text, opts) => {
    const result = originalPlan(text, opts);
    result.data.objective = '';
    result.data.selectedTools = ['ask', 'compare'];
    result.data.steps = [
      { id: 'first', tool: 'ask', action: 'ask', input: goal, riskTier: 'medium' },
      { id: 'other', tool: 'compare', action: 'compare', input: 'manifest | dosya', riskTier: 'medium' },
      { id: 'feedback', tool: 'ask', action: 'ask', input: goal, riskTier: 'medium' },
    ];
    return result;
  };
  const baseline = f.agent.run(goal, { ...f.opts, cognition: undefined, resume: false, maxIterations: 2 });
  assert.equal(baseline.ok, true);
  assert.deepEqual(baseline.data.steps.slice(0, 2).map(step => step.id), ['first', 'other']);
  const run = f.agent.run(goal, { ...f.opts, resume: false, maxIterations: 2 });
  assert.equal(run.ok, true);
  assert.deepEqual(run.data.steps.slice(0, 2).map(step => step.id), ['first', 'feedback'], JSON.stringify(run.data.cognition));
  const history = run.data.cognition.trail;
  assert.ok(history.some(row => row.outcome === 'contradiction' && row.reason === 'artifact_digest_observed'));
  const selections = history.filter(row => row.reason === 'salience_prepared');
  const before = selections[0].values.find(row => row.key === 'risk:ask');
  const after = selections[1].values.find(row => row.key === 'risk:ask');
  assert.equal(after.nObserved, before.nObserved + 1);
  assert.ok(after.arousal > before.arousal);
  assert.ok(after.value < before.value);
  assert.ok(run.data.queuedSteps.some(step => step.id === 'other'), 'deferred work stays queued');
});

test('fresh process replays the same source history and next ordering without changing the journal', t => {
  const f = environment(t);
  const options = { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z',
    historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'next' } };
  const expected = readValueLedger(f.kernel.graph, options);
  assert.equal(expected.status, 'MEASURED');
  const state = { workspaceId: 'default', observabilityRunId: 'new-run', iteration: 0, goal: frame.goal };
  const queue = [{ id: 'a', tool: 'ask' }, { id: 'b', tool: 'compare' }];
  const queued = structuredClone(queue);
  prepareCognition({ state, queued, opts: f.opts, graph: f.kernel.graph });
  const journal = f.kernel.graph.jsonJournalPath(); const before = fs.readFileSync(journal, 'utf8');
  const code = `const Graph=require('./graph');const {readValueLedger}=require('./lib/cognition-value-ledger-pairs');const {prepareCognition}=require('./lib/agent-cognition-seam');const data=JSON.parse(process.argv[2]);const graph=new Graph({useSQLite:false,memoryPath:process.argv[1]});prepareCognition({...data,graph});console.log(JSON.stringify({ledger:readValueLedger(graph,data.options),queue:data.queued}));`;
  const child = spawnSync(process.execPath, ['-e', code, f.memoryPath, JSON.stringify({
    state: { workspaceId: 'default', observabilityRunId: 'fresh', iteration: 0, goal: frame.goal }, queued: queue,
    opts: f.opts, options,
  })], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.deepEqual(output.ledger, expected);
  assert.deepEqual(output.queue, queued);
  assert.equal(fs.readFileSync(journal, 'utf8'), before);
});

test('actual family streak survives rescheduling and cannot displace a goal-named tier', () => {
  const candidates = [{ key: 'a', family: 'ask', urgency: 1 }, { key: 'b', family: 'compare', urgency: 0 }];
  const opts = { priorStreak: { family: 'ask', count: 2 }, starvationWindow: 2 };
  assert.equal(scheduleCandidates({ candidates }, opts).order[0], 'b');
  assert.equal(scheduleCandidates({ candidates }, { priorStreak: { family: 'ask', count: 100 }, starvationWindow: 100 }).order[0], 'b');
  assert.equal(scheduleCandidates({ candidates, goal: 'ask' }, opts).order[0], 'a');
  assert.equal(scheduleCandidates({ candidates }, { priorStreak: { family: 'ask', count: -1 } }).status, 'reject');
});
