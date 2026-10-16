'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { CausalRuntime } = require('../lib/causal/causal-runtime');
const { LearnedCausalEngine } = require('../lib/causal/learned-causal-engine');
const { episodeFromEvent, delta, digest, state, action } = require('../lib/causal/causal-episode-contract');
const { ACTIONS, NOOP, FRAME, policy, recordPair } = require('../lib/cognitive-lab-causal-world');

const PRE = { door: false, energized: true, jammed: false, nuisance: 1 };
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-learned-causal-'));
  const graph = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  const journal = createExperienceJournal();
  const runtime = new CausalRuntime({ graph, journal, frameId: FRAME, evaluatePolicy: policy, ...options });
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, graph, journal, runtime, simulator: new CausalSimulator(graph, { causalRuntime: runtime }) };
}
function train(journal, runtime, count = 3, opts = {}) {
  return Array.from({ length: count }, (_, index) => recordPair(journal, runtime, {
    id: `pair-${index}`, preState: { ...PRE, nuisance: index }, action: ACTIONS[1], ...opts }));
}
function predict(runtime, preState = PRE) { return runtime.forward({ preState, action: ACTIONS[1] }); }
function rawEvent(id = 'x', input = {}) {
  const postState = { ...PRE, door: true };
  return { runId: id, eventId: `${id}-treatment`, attemptId: `${id}-attempt`, workspaceId: 'default', sequence: 1,
    type: 'verification', executionStatus: 'completed', outcomeStatus: 'verified', payload: { causalEpisode: {
      frameId: FRAME, preState: PRE, action: ACTIONS[1], postState, effect: delta(PRE, postState), observedAt: '2026-01-01T00:00:00Z',
      assignment: { kind: 'controlled', pairId: id, arm: 'treatment', independenceKey: id }, ...input } } };
}

test('single episode and a single controlled pair never form a canonical rule', t => {
  const { journal, runtime } = setup(t);
  train(journal, runtime, 1);
  assert.equal(predict(runtime).status, 'UNKNOWN');
  assert.match(predict(runtime).reason, /insufficient/);
});

test('controlled independent transitions learn an effect and transfer across nuisance values through the real simulator', t => {
  const { journal, runtime, simulator } = setup(t);
  train(journal, runtime);
  const result = simulator.predictTransition({ preState: { ...PRE, nuisance: 1000 }, action: ACTIONS[1] });
  assert.equal(result.status, 'PREDICTED');
  assert.deepEqual(result.effect, { door: true });
  assert.equal(result.postState.nuisance, 1000);
  assert.equal(result.independentSamples, 3);
  assert.equal(result.support.length, 6);
  assert.equal(result.canonicalRule, false);
  assert.equal(result.authority, 'PREDICTIVE_MODEL_ONLY');
  assert.equal(runtime.inspect().episodes, 6);
  assert.equal(predict(runtime, { ...PRE, energized: false }).status, 'UNKNOWN');
  assert.equal(predict(runtime, { ...PRE, jammed: true }).status, 'UNKNOWN');
});

test('observational correlation and time order cannot establish causality', t => {
  const { journal, runtime } = setup(t);
  train(journal, runtime, 6, { kind: 'observational' });
  assert.equal(predict(runtime).status, 'UNKNOWN');
});

test('correlated source copies do not inflate independent support', t => {
  const { journal, runtime } = setup(t);
  train(journal, runtime, 6, { independenceKey: 'same-origin' });
  assert.equal(predict(runtime).status, 'UNKNOWN');
});

test('same run copies with renamed independence keys remain correlated', () => {
  const episodes = [];
  for (let index = 0; index < 4; index++) {
    const treatment = rawEvent(`id-${index}`);
    treatment.runId = 'same-run';
    const control = rawEvent(`control-${index}`, { action: NOOP, postState: PRE, effect: {},
      assignment: { kind: 'controlled', pairId: `id-${index}`, arm: 'control', independenceKey: `id-${index}` } });
    control.runId = 'same-run';
    episodes.push(episodeFromEvent(treatment, { workspaceId: 'default', frameId: FRAME }), episodeFromEvent(control, { workspaceId: 'default', frameId: FRAME }));
  }
  assert.equal(new LearnedCausalEngine({ episodes }).forward({ workspaceId: 'default', frameId: FRAME, preState: PRE, action: ACTIONS[1] }).status, 'UNKNOWN');
});

test('controlled null effect remains no-effect rather than a causal success', t => {
  const { journal, runtime } = setup(t);
  train(journal, runtime, 3, { preState: { ...PRE, energized: false } });
  const result = predict(runtime, { ...PRE, energized: false });
  assert.equal(result.status, 'PREDICTED');
  assert.deepEqual(result.effect, {});
  assert.equal(result.postState.door, false);
});

test('a changing control cannot support an effect attributed to treatment', t => {
  const { journal, runtime } = setup(t);
  for (let i = 0; i < 4; i++) {
    const treatment = rawEvent(`confounder-${i}`);
    delete treatment.sequence;
    assert.equal(journal.append(treatment).ok, true);
    runtime.observeJournalEpisode({ runId: treatment.runId, eventId: treatment.eventId });
    const control = rawEvent(`control-${i}`, { action: NOOP,
      assignment: { kind: 'controlled', pairId: `confounder-${i}`, arm: 'control', independenceKey: `confounder-${i}` } });
    delete control.sequence;
    assert.equal(journal.append(control).ok, true);
    runtime.observeJournalEpisode({ runId: control.runId, eventId: control.eventId });
  }
  assert.equal(predict(runtime).status, 'UNKNOWN');
});

test('support withdrawal invalidates derived model and survives actual SQLite reopening', t => {
  const { journal, runtime, graph, dir } = setup(t);
  const hashes = train(journal, runtime);
  const before = predict(runtime);
  assert.equal(before.status, 'PREDICTED');
  assert.equal(runtime.withdrawSupport({ sourceHash: hashes[0][0], reason: 'source superseded' }).replayed, false);
  assert.equal(runtime.withdrawSupport({ sourceHash: hashes[0][0], reason: 'another reason' }).replayed, true);
  assert.equal(predict(runtime).status, 'UNKNOWN');
  graph.closeSqlite();
  const reopened = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  try {
    const resumed = new CausalRuntime({ graph: reopened, journal: createExperienceJournal(), frameId: FRAME, evaluatePolicy: policy });
    assert.equal(predict(resumed).status, 'UNKNOWN');
    assert.deepEqual(resumed.inspect().withdrawn, [hashes[0][0]]);
  } finally { reopened.closeSqlite(); }
});

test('episode replay is idempotent and changed source under same identity is refused', t => {
  const { journal, runtime, graph } = setup(t);
  train(journal, runtime);
  assert.equal(runtime.observeJournalEpisode({ runId: 'pair-0', eventId: 'pair-0-treatment' }).replayed, true);
  assert.equal(runtime.inspect().episodes, 6);
  const conflictingJournal = { read: () => [rawEvent('pair-0', { postState: PRE, effect: {} })] };
  const other = new CausalRuntime({ graph, journal: conflictingJournal, frameId: FRAME });
  assert.throws(() => other.observeJournalEpisode({ runId: 'pair-0', eventId: 'pair-0-treatment' }), /idempotency conflict/);
});

test('workspace and frame boundaries reject source and cannot be overridden by a prediction request', t => {
  const { journal, runtime, graph } = setup(t);
  train(journal, runtime);
  const foreign = new CausalRuntime({ graph, journal, workspaceId: 'foreign', frameId: FRAME });
  assert.throws(() => foreign.observeJournalEpisode({ runId: 'pair-0', eventId: 'pair-0-treatment' }), /workspace mismatch/);
  const otherFrame = new CausalRuntime({ graph, journal, frameId: 'other-frame' });
  assert.throws(() => otherFrame.observeJournalEpisode({ runId: 'pair-0', eventId: 'pair-0-treatment' }), /frame mismatch/);
  assert.equal(predict(otherFrame).status, 'UNKNOWN');
  assert.equal(runtime.forward({ workspaceId: 'foreign', frameId: 'foreign', preState: PRE, action: ACTIONS[1] }).status, 'PREDICTED');
});

test('inverse keeps rejected alternatives and never bypasses a missing, failing, or blocking policy', t => {
  const { journal, runtime, graph } = setup(t);
  train(journal, runtime);
  const inverse = runtime.inverse({ preState: PRE, desiredState: { door: true }, actions: ACTIONS });
  assert.equal(inverse.status, 'CANDIDATES');
  assert.equal(inverse.candidates[0].action.name, 'unlock');
  assert.equal(inverse.rejected[0].action.name, 'force');
  for (const evaluatePolicy of [undefined, () => { throw new Error('offline'); }, () => ({ verdict: 'unknown' })]) {
    const denied = new CausalRuntime({ graph, journal, frameId: FRAME, evaluatePolicy });
    const result = denied.inverse({ preState: PRE, desiredState: { door: true }, actions: ACTIONS });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejected.length, ACTIONS.length);
  }
});

test('real recorded contrary outcome defeats prediction and produces an unverified failure hypothesis', t => {
  const { journal, runtime, simulator } = setup(t);
  train(journal, runtime);
  const prediction = predict(runtime);
  const event = rawEvent('contrary', { postState: PRE, effect: {},
    assignment: { kind: 'observational', pairId: 'contrary', arm: 'treatment', independenceKey: 'contrary' } });
  delete event.sequence;
  assert.equal(journal.append(event).ok, true);
  const failure = simulator.explainFailure({ prediction, preState: PRE, runId: event.runId, eventId: event.eventId });
  assert.equal(failure.status, 'MISMATCH');
  assert.equal(failure.hypothesis.status, 'UNVERIFIED');
  assert.equal(failure.hypothesis.canonicalRule, false);
  assert.equal(predict(runtime).status, 'UNKNOWN');
  const success = new LearnedCausalEngine().failure({ prediction, preState: PRE, observedPostState: prediction.postState });
  assert.equal(success.status, 'CONFIRMED');
});

test('missing outcome, unsupported event, malformed effect and source identity fail closed', t => {
  const { journal, runtime } = setup(t);
  assert.throws(() => runtime.observeJournalEpisode({ runId: 'missing', eventId: 'missing' }), /unavailable/);
  for (const mutate of [event => { event.outcomeStatus = 'unknown'; }, event => { event.executionStatus = 'failed'; },
    event => { event.payload.causalEpisode.effect = { door: false }; }, event => { delete event.attemptId; },
    event => { event.payload.causalEpisode.observedAt = 'missing'; }, event => { event.payload.causalEpisode.assignment.kind = 'unverified'; }]) {
    const event = rawEvent(`invalid-${Math.random()}`); mutate(event); delete event.sequence;
    assert.equal(journal.append(event).ok, true);
    assert.throws(() => runtime.observeJournalEpisode({ runId: event.runId, eventId: event.eventId }));
  }
  assert.equal(runtime.inspect().episodes, 0);
});

test('bounded state/action and operation budget guard hostile or oversized input', t => {
  const { journal, runtime, graph } = setup(t);
  train(journal, runtime);
  const bounded = new CausalRuntime({ graph, journal, frameId: FRAME, maxOperations: 1 });
  assert.equal(predict(bounded).reason, 'operation_budget_exhausted');
  assert.throws(() => state({ value: NaN }), /bounded scalar/);
  assert.throws(() => state(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))), /scalar keys/);
  assert.throws(() => state(JSON.parse('{"__proto__":1}')), /invalid key/);
  assert.throws(() => action({ name: 'x', args: {}, cost: -1 }), /bounded/);
  assert.throws(() => new LearnedCausalEngine({ minSupport: 1 }), /between/);
  assert.throws(() => new LearnedCausalEngine({ episodes: Array(513) }), /budget/);
});

test('persistence rollback is observable and a corrupted ledger never becomes training evidence', t => {
  const { journal, runtime, graph } = setup(t);
  train(journal, runtime, 1);
  const fail = new CausalRuntime({ graph: { getCommittedMutationResultsByPrefix: () => [], runMutationOnce: () => { throw new Error('disk failed'); } }, journal, frameId: FRAME });
  assert.throws(() => fail.observeJournalEpisode({ runId: 'pair-0', eventId: 'pair-0-treatment' }), /disk failed/);
  const rows = graph.getCommittedMutationResultsByPrefix(runtime.prefix);
  const corrupted = JSON.parse(JSON.stringify(rows));
  corrupted[0].result.episode.postState.door = false;
  const tampered = new CausalRuntime({ graph: { getCommittedMutationResultsByPrefix: () => corrupted, runMutationOnce() {} }, journal, frameId: FRAME });
  assert.throws(() => predict(tampered), /integrity mismatch/);
  const { hash: _hash, ...body } = corrupted[0].result;
  corrupted[0].result.hash = digest(body);
  assert.throws(() => predict(tampered), /source binding mismatch/);
});

test('unconfigured simulator keeps topology simulation separate and abstains on learned operations', t => {
  const { graph } = setup(t);
  const simulator = new CausalSimulator(graph);
  assert.equal(simulator.predictTransition({}).status, 'UNKNOWN');
  assert.equal(simulator.proposeActions({}).status, 'UNKNOWN');
  assert.equal(simulator.explainFailure({}).status, 'UNKNOWN');
});

test('public failure model never confirms an incomplete or changed outcome schema', () => {
  const engine = new LearnedCausalEngine();
  const prediction = { status: 'PREDICTED', modelId: 'bound', postState: { a: 1, b: 1 }, effect: { b: 1 } };
  for (const observedPostState of [{ a: 1 }, { a: 1, b: 1, extra: true }]) {
    const result = engine.failure({ prediction, preState: { a: 1, b: 0 }, observedPostState });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'incomplete_or_changed_outcome_schema');
  }
  assert.equal(engine.failure({ prediction: { ...prediction, postState: { a: 1 } }, preState: { a: 1, b: 0 }, observedPostState: { a: 1, b: 1 } }).reason, 'invalid_prediction_schema');
  const complete = engine.failure({ prediction, preState: { a: 1, b: 0 }, observedPostState: { a: 1, b: 1 } });
  assert.equal(complete.status, 'CONFIRMED');
  assert.deepEqual(complete.predictedEffect, { b: 1 });
  assert.deepEqual(complete.observedEffect, { b: 1 });
});
