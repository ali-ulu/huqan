'use strict';

const { MANIFEST_SCHEMA_VERSION, computeManifestDigest } = require('../../lib/cognitive-lab-manifest');
const { ELEVEN_BINS } = require('../../lib/cognitive-lab-probability-calibration');

function comparisonInput(overrides = {}) {
  const protocol = {
    bins: [...ELEVEN_BINS], minObserved: 10, metricDirection: 'lower-is-better', meaningfulEffect: 0.01,
    nonInferiority: { brier: 0, ece: 0 },
    uncertainty: { method: 'paired-bootstrap-percentile', confidence: 0.95, resamples: 200 },
  };
  const tasks = [{ taskId: 'train', sourceEventId: 'event:train', split: 'train' }];
  for (const split of ['holdout', 'transfer']) {
    for (let i = 0; i < 10; i += 1) tasks.push({ taskId: `${split}-${i}`, sourceEventId: `event:${split}-${i}`, split });
  }
  tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const split = Object.fromEntries(['train', 'holdout', 'transfer'].map(name => [name, tasks.filter(t => t.split === name).map(t => t.taskId).sort()]));
  const budget = { modelCalls: 100, toolCalls: 100, humanCalls: 100, tokens: 1000, wallTimeMs: 60000, compute: 100 };
  return {
    schemaVersion: 'huqan-cognitive-lab-comparison-v1', runId: 'paired-test',
    experiment: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      source: { repository: 'ali-ulu/huqan', commit: 'b9250e18cf9e97a7308adfc3d315da2c85abaafd', dirty: false },
      fixture: { digest: computeManifestDigest(tasks) },
      split: { identity: computeManifestDigest(split), ...split },
      frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'test', task: 'paired-calibration' },
      seed: 42, mechanisms: Object.fromEntries(['B1','B2','B3','B4','B5','B6','B7','B8'].map(id => [id, id === 'B1' ? 'ENABLED' : 'NOT_MEASURED'])),
      budget, measurementVersion: 'paired-calibration-v1', thresholdConfigHash: computeManifestDigest(protocol),
    },
    variants: { baseline: 'explicit-baseline', candidate: 'explicit-candidate' }, tasks, protocol,
    ...overrides,
  };
}

function records(input, probability = 0.5) {
  return input.tasks.filter(t => t.split !== 'train').map(t => ({
    decisionId: t.taskId, probability, status: 'observed', outcome: 'confirmed', y: 1,
  }));
}

function budgets(input) {
  const usage = { modelCalls: 0, toolCalls: 0, humanCalls: 20, tokens: 0, wallTimeMs: 100, compute: 0 };
  return Object.fromEntries(['baseline','candidate'].map(name => [name, { envelope: { ...input.experiment.budget }, usage: { ...usage } }]));
}

module.exports = { comparisonInput, records, budgets };
