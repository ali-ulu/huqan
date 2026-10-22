'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareCognition, beginStepCognition, observeStepCognition } = require('../lib/agent-cognition-seam');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Graph = require('../graph');
const { readValueLedger } = require('../lib/cognition-value-ledger-pairs');
const { recordPrediction, recordOutcome } = require('../lib/prediction-outcome-pairs');
const { finishObservation } = require('../lib/agent-cognition-observation');
const digest = value => createHash('sha256').update(value).digest('hex');
const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-22T00:00:00Z', goal: 'artifact validation', task: 'digest-check-v1' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-seam-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'artifact.txt'); fs.writeFileSync(target, 'before');
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'graph.json') });
  const state = { workspaceId: 'default', observabilityRunId: 'r', iteration: 0, goal: frame.goal };
  const opts = { cognition: flags, cognitiveScheduler: {}, cognitionFrame: frame,
    cognitionFileExpectations: { a: { workspaceId: 'default', path: target, expectedDigest: digest('after'),
      sourceGroup: 'artifact-group', riskScore: 0 } } };
  return { graph, state, opts, target, step: { id: 'a', tool: 'ask' } };
}

const flags = { predictionError: true, reward: true, value: true, percept: true, salience: true };
test('without cognition the queue and state stay byte-identical', () => {
  const state = { workspaceId: 'w' }; const queued = [{ id: 'a', tool: 'ask' }];
  const before = JSON.stringify({ state, queued });
  assert.equal(prepareCognition({ state, queued }), null);
  assert.equal(observeStepCognition({ state, report: { status: 'done', result: { ok: true } } }), null);
  assert.equal(JSON.stringify({ state, queued }), before);
});
test('salience without scheduler records a bounded no-op', () => {
  const state = { workspaceId: 'w' }; const queued = [{ id: 'a', tool: 'ask' }];
  for (let i = 0; i < 40; i++) prepareCognition({ state, queued, opts: { cognition: flags } });
  assert.equal(state.cognition.trail.length, 32);
  assert.equal(state.cognition.trail[0].reason, 'salience_without_scheduler');
  assert.deepEqual(queued, [{ id: 'a', tool: 'ask' }]);
});
test('reported success without an independent expectation cannot create rewards', () => {
  const state = { workspaceId: 'w', observabilityRunId: 'r' };
  const opts = { cognition: flags, cognitiveScheduler: {} };
  const queued = [{ id: 'a', tool: 'ask' }, { id: 'b', tool: 'verify' }];
  prepareCognition({ state, queued, opts });
  const result = observeStepCognition({ state, opts, step: queued[0], report: { status: 'done', result: { ok: true } } });
  assert.equal(result.status, 'ABSTAIN');
  assert.equal(result.reason, 'independent_observation_unavailable');
});

test('predeclared digest is observed independently and scoped by the real journal producer', t => {
  const f = fixture(t);
  assert.ok(beginStepCognition(f));
  f.opts.cognitionFileExpectations.a.expectedDigest = digest('forged-after-action');
  fs.writeFileSync(f.target, 'after');
  const observed = observeStepCognition({ ...f, report: { status: 'done', result: { ok: true } } });
  assert.equal(observed.status, 'MEASURED');
  assert.equal(observed.outcome, 'confirmed');
  const ledger = readValueLedger(f.graph, { workspaceId: 'default', asOf: '2090-01-01T00:00:00Z',
    historyBoundary: { at: '2090-01-01T00:00:00Z', decisionId: 'next' } });
  assert.equal(ledger.entries[0].nObserved, 1);
  assert.equal(ledger.entries[0].nIndependent, 1);
  assert.equal(ledger.status, 'INSUFFICIENT');
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).status, 'ABSTAIN');
});

test('a changed file with the wrong digest contradicts only the artifact expectation', t => {
  const f = fixture(t); beginStepCognition(f); fs.writeFileSync(f.target, 'wrong-change');
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).outcome, 'contradiction');
});

test('cross-workspace declarations and unreadable or retargeted sources abstain', t => {
  const f = fixture(t);
  f.opts.cognitionFileExpectations.a.workspaceId = 'other';
  assert.equal(beginStepCognition(f), null);
  f.opts.cognitionFileExpectations.a.workspaceId = 'default';
  beginStepCognition(f); fs.unlinkSync(f.target);
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).status, 'ABSTAIN');
});

test('scoped prediction rebinding and an outcome key for another decision are refused', t => {
  const f = fixture(t); const pending = beginStepCognition(f);
  assert.throws(() => recordPrediction(f.graph, { decisionId: pending.decisionId, score: 0,
    binding: { ...pending.binding, workspaceId: 'other' } }), /binding conflict/);
  observeStepCognition({ ...f, report: { status: 'done' } });
  assert.throws(() => recordOutcome(f.graph, { decisionId: 'another', outcome: 'confirmed',
    idempotencyKey: pending.decisionId }), /binding conflict/);
});

test('partial scheduler orders preserve every queued step and original step objects', t => {
  const f = fixture(t);
  const queued = [{ id: 'a', tool: 'ask', riskTier: 'high' }, { id: 'b', tool: 'verify', riskTier: 'low' }];
  const before = JSON.stringify(queued);
  prepareCognition({ ...f, queued, goal: 'ask' });
  assert.equal(JSON.stringify(queued), before);
  f.state.pendingRepair = { repairStepId: 'a' };
  assert.equal(prepareCognition({ ...f, queued }), null);
});

test('replaying a decision returns its immutable outcome even if the file later changes', t => {
  const f = fixture(t); const pending = beginStepCognition(f);
  fs.writeFileSync(f.target, 'after');
  assert.equal(finishObservation({ ...f, pending, report: { status: 'done' } }).outcome, 'confirmed');
  fs.writeFileSync(f.target, 'changed-again');
  const replay = finishObservation({ ...f, pending, report: { status: 'done' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, 'confirmed');
  assert.equal(replay.reason, 'artifact_outcome_replayed');
});

test('habituation follows the same percept key rather than the entire tool family', t => {
  const f = fixture(t); f.opts.cognitionFileExpectations.a.expectedDigest = digest('before');
  const pending = beginStepCognition(f);
  observeStepCognition({ ...f, report: { status: 'done' } });
  f.state.observabilityRunId = 'next-run';
  assert.equal(beginStepCognition(f).binding.perceptKey, pending.binding.perceptKey);
  delete f.state.cognition.pending;
  const other = path.join(path.dirname(f.target), 'fresh.txt'); fs.writeFileSync(other, 'before');
  f.opts.cognitionFileExpectations.b = { ...f.opts.cognitionFileExpectations.a, path: other, sourceGroup: 'fresh' };
  const queued = [{ id: 'a', tool: 'ask' }, { id: 'b', tool: 'ask' }];
  const result = prepareCognition({ ...f, queued, goal: frame.goal });
  const score = key => result.ranked.find(row => row.key === key).salience;
  assert.ok(score('b') > score('a'));
  assert.equal(queued[0].id, 'b');
});

test('the exact pre-decision snapshot resolves equal wall-clock milliseconds without future leakage', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    const target = path.join(path.dirname(f.target), `source-${i}.txt`); fs.writeFileSync(target, 'after');
    f.state.observabilityRunId = `run-${i}`;
    f.opts.cognitionFileExpectations.a = { ...f.opts.cognitionFileExpectations.a, path: target, sourceGroup: `group-${i}` };
    beginStepCognition(f); observeStepCognition({ ...f, report: { status: 'done' } });
  }
  const RealDate = Date; const at = new RealDate(RealDate.now() + 1000).toISOString();
  const rows = f.graph.getCommittedMutationResultsByPrefix('prediction-outcome:').map(row => ({ ...row, committedAt: at,
    result: row.result.outcome ? { ...row.result, outcome: { ...row.result.outcome, at } } : row.result }));
  t.mock.method(global, 'Date', class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } });
  const graph = { getCommittedMutationResultsByPrefix: () => rows };
  const result = prepareCognition({ ...f, graph, queued: [{ id: 'b', tool: 'ask' }], goal: frame.goal });
  assert.equal(result.values[0].status, 'MEASURED');
  assert.equal(result.values[0].nObserved, 3);
  rows.push({ ...rows[1], result: { ...rows[1].result, decisionId: 'future' }, committedAt: new RealDate(RealDate.parse(at) + 1).toISOString() });
  const next = prepareCognition({ ...f, graph, queued: [{ id: 'b', tool: 'ask' }], goal: frame.goal });
  assert.equal(next.values[0].nObserved, 3);
});

test('foreign workspace history cannot affect either prediction error or value ranking', t => {
  const f = fixture(t); const queued = [{ id: 'a', tool: 'ask' }, { id: 'b', tool: 'compare' }];
  const baseline = prepareCognition({ ...f, queued: structuredClone(queued), goal: frame.goal });
  const opts = { ...f.opts, cognitionFileExpectations: { a: { ...f.opts.cognitionFileExpectations.a, workspaceId: 'other' } } };
  for (let i = 0; i < 5; i++) {
    const state = { ...f.state, cognition: undefined, workspaceId: 'other', observabilityRunId: `foreign-${i}` };
    beginStepCognition({ ...f, state, opts });
    assert.equal(observeStepCognition({ ...f, state, opts, report: { status: 'done' } }).outcome, 'contradiction');
  }
  const result = prepareCognition({ ...f, queued: structuredClone(queued), goal: frame.goal });
  assert.deepEqual(result.values, []);
  assert.deepEqual(result.ranked, baseline.ranked);
});

test('a canonical target changed through a directory link abstains', t => {
  const f = fixture(t); const root = path.dirname(f.target);
  const one = path.join(root, 'one'); const two = path.join(root, 'two'); const link = path.join(root, 'link');
  fs.mkdirSync(one); fs.mkdirSync(two);
  for (const dir of [one, two]) fs.writeFileSync(path.join(dir, 'target'), 'before');
  try { fs.symlinkSync(one, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('directory links unavailable'); return; } throw error; }
  f.opts.cognitionFileExpectations.a.path = path.join(link, 'target');
  assert.ok(beginStepCognition(f));
  fs.renameSync(link, path.join(root, 'old-link'));
  fs.symlinkSync(two, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(observeStepCognition({ ...f, report: { status: 'done' } }).reason, 'observation_binding_mismatch');
});

test('a blocked action cannot earn an outcome even when the artifact matches', t => {
  const f = fixture(t); assert.ok(beginStepCognition(f)); fs.writeFileSync(f.target, 'after');
  const result = observeStepCognition({ ...f, report: { status: 'blocked', result: { ok: true } } });
  assert.equal(result.status, 'ABSTAIN');
  const rows = f.graph.getCommittedMutationResultsByPrefix('prediction-outcome:');
  assert.equal(rows.filter(row => row.result.outcome).length, 0);
  assert.equal(f.state.cognition.pending, undefined);
});
