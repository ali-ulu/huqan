'use strict';

/**
 * #3474 B7 preregistration. Frozen before any measurement: a change here must
 * also change fixtures/cognitive-lab/neural-cognition-design.json, which a test
 * pins, and every digest below is recomputed in the same edit.
 *
 * The design names the model shape, the split sizes, the baselines, the
 * thresholds and the kill criteria before a single outcome is observed, so no
 * threshold can be chosen after seeing which arm won. The generator emits
 * *inputs only* -- states, never labels -- so a leaked outcome cannot enter the
 * training data.
 */

const { STEPS } = require('./cognitive-lab-neural-world');

const DESIGN = Object.freeze({
  schemaVersion: 'huqan-neural-cognition-experiment-v1',
  seed: 3474,
  world: 'bounded-binary-accumulation-v1',
  scope: 'Synthetic bounded binary sequences in one frame; no external task, language, vision or general-capability claim',
  split: { train: { prefix: 'train', count: 400 }, holdout: { prefix: 'holdout', count: 320 }, transfer: { prefix: 'transfer', count: 320 } },
  transfer: 'Unseen sequence draws and distinct case ids; same law, frame and input distribution, no re-used draw',
  model: { kind: 'SSM', reservoir: 24, ridge: 0.5, steps: STEPS, locality: 'LOCAL' },
  budget: { modelCalls: 0, toolCalls: 0, humanCalls: 0, tokens: 0, maxTrainingSamples: 4096, maxParameters: 4096, maxOperationsPerPrediction: 1000000 },
  baseline: {
    majority: 'Persistence: always predict the training split majority label',
    memoryless: 'Predict positive iff the final step is 1; a deterministic model with no memory of the sequence',
  },
  primary: 'Accuracy of the local recurrent model on the holdout and transfer splits, paired against both baselines',
  thresholds: {
    minimumSamplesPerSplit: 320,
    minimumQuality: 0.75,
    minimumAccuracyGain: 0.05,
    minimumGainLowerBound: 0.02,
    maximumExternalCalls: 0,
  },
  uncertainty: 'Conservative bounded synthetic case score: mean(delta)-sqrt(2*log(20)/n) on 0/1 outcomes; no real-task population CI claim',
  metrics: {
    quality: ['candidateAccuracy', 'majorityAccuracy', 'memorylessAccuracy', 'pairedGainVsMajority', 'pairedGainVsMemoryless', 'falsePositives', 'falseNegatives'],
    budget: ['modelCalls', 'tokens', 'operations', 'trainingSamples', 'parameters'],
    locality: ['locality', 'externalCalls'],
    calibration: 'NOT_MEASURED: the readout score is not a calibrated probability and no outcome-probability pairing is declared in this slice',
  },
  negativeControls: [
    'zero training samples',
    'a single repeated input',
    'an untrained model',
    'an external locality declared',
    'a budget overrun',
  ],
  mutations: [
    'accept an external locality',
    'score an untrained model',
    'count the training split as holdout',
  ],
  killCriteria: [
    'overlapping splits',
    'design, fixture or environment digest mismatch',
    'any external call or token usage',
    'a non-finite score',
    'quality below the minimum',
    'accuracy gain below the lower bound',
  ],
  promotion: 'No automatic model, memory or graph-rule promotion; KEEP is experimental only',
  phase: 'CONFIRMATORY_PREREGISTERED',
});

/** Seeded inputs only: bounded 0/1 sequences and case ids. Never labels. */
function generateDataset(seed = DESIGN.seed, split = DESIGN.split) {
  let state = (Number(seed) >>> 0) || 1;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const make = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${seed}-${index}`,
    sequence: Array.from({ length: STEPS }, () => (random() < 0.5 ? 1 : 0)),
  }));
  return {
    train: make(split.train.prefix, split.train.count),
    splits: [
      { name: 'holdout', cases: make(split.holdout.prefix, split.holdout.count) },
      { name: 'transfer', cases: make(split.transfer.prefix, split.transfer.count) },
    ],
  };
}

// Recorded at preregistration. The runner refuses to measure when the design,
// the generated inputs or the environment law drift.
const FROZEN = Object.freeze({
  designDigest: 'dc8293178dbd6e80b0ca278f2fc756a84f94e6a7f2202ab59bf7d4b895c72fef',
  fixtureDigest: '8b0f9c58422e0f1fc0d2ac7287b1fd701e4845a89dea77eb8c8b2f044831d169',
  worldDigest: '0361616e70cd8124aeb11d6fbc75eaa9800390bf12f45a3a0c73d8620bd16b4a',
});

module.exports = { DESIGN, FROZEN, generateDataset };
