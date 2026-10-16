'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { runCausalExperiment, gain } = require('../lib/cognitive-lab-causal-experiment');
const { main } = require('../bin/huqan-causal-lab');
const design = require('../fixtures/cognitive-lab/causal-design.json');

test('real experiment runner reports unseen B2/B3, policy rejection, equal slots and honest insufficient sample status', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-causal-experiment-test-'));
  const graph = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  const small = { ...design, split: { ...design.split, train: { prefix: 'train', count: 12 }, holdout: { prefix: 'holdout', count: 4 }, transfer: { prefix: 'transfer', count: 4 } } };
  const result = runCausalExperiment({ graph, journal: createExperienceJournal(), createSimulator: (store, options) => new CausalSimulator(store, options),
    design: small, sourceCommit: design.sourceBase, sourceDirty: true });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.manifest.source.dirty, true);
  assert.equal(result.manifest.mechanisms.B2, 'ENABLED');
  assert.equal(result.manifest.mechanisms.B3, 'ENABLED');
  assert.equal(result.manifest.mechanisms.B1, 'NOT_MEASURED');
  assert.equal(result.trainingEpisodes, 48);
  for (const report of result.reports) {
    assert.equal(report.B2.candidateAccuracy, 1);
    assert.equal(report.B2.baselineAccuracy, .75);
    assert.equal(report.B2.falseCausalRuleRate, 0);
    assert.equal(report.B3.candidateGoalReach, 1);
    assert.equal(report.B3.baselineGoalReach, .25);
    assert.equal(report.B3.unsafeRejections, 4);
    assert.equal(report.B3.unsafeSelected, 0);
    assert.equal(report.budget.assertsEqualBudget, true);
    assert.equal(report.measuredCompute.equalActualCompute, 'NOT_MEASURED');
    assert.ok(report.cases.every(item => item.id.startsWith(report.split)));
  }
  assert.equal(result.automaticPromotion, false);
});

test('experiment refuses missing source provenance and malformed frozen configuration before training', () => {
  assert.throws(() => runCausalExperiment({ design }), /source commit/);
  assert.throws(() => runCausalExperiment({ design, sourceCommit: design.sourceBase }), /source dirty/);
  assert.throws(() => runCausalExperiment({ design: { ...design, seed: 0 } }), /frozen/);
  assert.throws(() => runCausalExperiment({ design: { ...design, split: { ...design.split, holdout: { prefix: 'holdout', count: 0 } } } }), /bounded/);
});

test('paired lower bound is conservative and reacts to reduced or adverse samples', () => {
  const result = gain(Array(160).fill(0), Array(160).fill(1));
  assert.equal(result.mean, 1);
  assert.ok(result.lower95 < 1 && result.lower95 > .8);
  assert.ok(gain([0], [1]).lower95 < 0);
  assert.equal(gain([1, 1], [0, 0]).mean, -1);
});

test('installed CLI help and invalid requests do not create an experiment or open canonical memory', () => {
  assert.match(main(['--help']).usage, /huqan-causal-lab/);
  assert.throws(() => main([]), /explicit/);
  assert.throws(() => main(['--source-commit', 'not-a-sha', '--source-dirty', 'false']), /explicit/);
});
