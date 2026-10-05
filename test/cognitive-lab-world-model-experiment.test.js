'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { contentHash } = require('../lib/content-hash');
const { digest } = require('../lib/causal/causal-episode-contract');
const { runWorldModelExperiment, splitReport } = require('../lib/cognitive-lab-world-model-experiment');
const { DESIGN, FROZEN, generateDataset } = require('../lib/cognitive-lab-world-model-design');
const { main } = require('../bin/huqan-causal-lab');
const preregistered = require('../fixtures/cognitive-lab/world-model-design.json');

const SHA = 'a'.repeat(40);
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-world-model-experiment-'));
  const graph = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  return graph;
}
const create = (graph, options) => new CausalSimulator(graph, options);

test('the shipped design, inputs and environment law equal the preregistered frozen record', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DESIGN)), preregistered.design);
  assert.deepEqual({ ...FROZEN }, preregistered.frozen);
  assert.equal(digest(DESIGN), FROZEN.designDigest);
  assert.equal(digest(generateDataset()), FROZEN.fixtureDigest);
  const world = fs.readFileSync(path.join(__dirname, '..', 'lib/cognitive-lab-world-model-world.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(contentHash(world), FROZEN.worldDigest);
});

test('a small unfrozen run is INSUFFICIENT yet reports honest B5 prediction and planning metrics', t => {
  const graph = store(t);
  const small = { ...DESIGN, split: { train: { prefix: 'train', count: 12 }, holdout: { prefix: 'holdout', count: 24 }, transfer: { prefix: 'transfer', count: 24 } } };
  const result = runWorldModelExperiment({ graph, journal: createExperienceJournal(), createSimulator: create, design: small, sourceCommit: SHA, sourceDirty: true });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.frozenInputsVerified, false);
  assert.equal(result.trainingEpisodes, 96);
  assert.equal(result.manifest.mechanisms.B5, 'ENABLED');
  assert.equal(result.automaticPromotion, false);
  for (const report of result.reports) {
    assert.equal(report.status, 'INSUFFICIENT');
    assert.equal(report.prediction.falseTransitions, 0);
    assert.equal(report.prediction.untrainedPredicted, 0);
    assert.ok(report.prediction.unknownRate > 0, 'reset probe plans stay UNKNOWN');
    assert.equal(report.planning.falseSuccess, 0);
    assert.equal(report.planning.unsafeSelected, 0);
    assert.equal(report.planning.candidateGoalReach, 1);
    assert.equal(report.planning.modelFreeGoalReach, 0.25);
    assert.ok(report.planning.meanCostReductionVsSingleStep > 0);
    assert.equal(report.planning.plansComparedPerCase, 7);
    assert.ok(report.cases.every(row => row.rejectedVisible && row.unknownVisible));
  }
});

test('a false success, a false transition or a cost regression rejects an otherwise adequate split', () => {
  const row = { persistenceCorrect: 0, finalCorrect: 1, modelFreeReached: 0, candidateReached: 1, singleStepReached: 1, singleStepCost: 6, selectedCost: 3,
    falseTransitions: 0, falseSuccess: 0, unsafeSelected: 0, untrainedPredicted: false, plansCompared: 7, rejectedVisible: true, unknownVisible: true, probeStatus: 'PREDICTED', predictedSteps: 3 };
  const rows = changes => Array.from({ length: 160 }, (_, i) => (i === 0 ? { ...row, ...changes } : row));
  const thresholds = DESIGN.thresholds;
  assert.equal(splitReport('holdout', rows({}), thresholds).status, 'KEEP');
  assert.equal(splitReport('holdout', rows({ falseSuccess: 1 }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ falseTransitions: 1 }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ selectedCost: 7 }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ untrainedPredicted: true }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ unknownVisible: false }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({}).slice(1), thresholds).status, 'INSUFFICIENT');
});

test('the runner refuses missing provenance, a foreign design and overlapping splits before training', () => {
  assert.throws(() => runWorldModelExperiment({ createSimulator: create }), /source commit/);
  assert.throws(() => runWorldModelExperiment({ createSimulator: create, sourceCommit: SHA }), /source dirty/);
  assert.throws(() => runWorldModelExperiment({ sourceCommit: SHA, sourceDirty: false }), /simulator/);
  assert.throws(() => runWorldModelExperiment({ createSimulator: create, sourceCommit: SHA, sourceDirty: false, design: { ...DESIGN, world: 'other' } }), /design/);
  const dataset = generateDataset();
  const overlapping = { ...dataset, splits: [{ name: 'holdout', cases: dataset.train }, dataset.splits[1]] };
  assert.throws(() => runWorldModelExperiment({ createSimulator: create, sourceCommit: SHA, sourceDirty: false, dataset: overlapping }), /overlapping/);
});

test('the installed CLI exposes B5 and validates its arguments without opening memory', () => {
  assert.match(main(['--help']).usage, /--benchmark B5/);
  assert.equal(main(['--help']).benchmarks.B5, DESIGN.scope);
  assert.throws(() => main(['--benchmark', 'B5']), /explicit/);
  assert.throws(() => main(['--benchmark', 'B5', '--source-commit', 'x', '--source-dirty', 'false']), /explicit/);
});
