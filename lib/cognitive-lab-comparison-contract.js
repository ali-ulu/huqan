'use strict';

// #3414: preregistration only. No outcome or forecast belongs in this contract.
const { buildManifest, computeManifestDigest } = require('./cognitive-lab-manifest');
const { isPlainObject } = require('./is-plain-object');
const { MIN_OBSERVED_RECORDS, calibrate, ELEVEN_BINS } = require('./cognitive-lab-probability-calibration');
const { lockContract, BOOTSTRAP_METHOD, DIRECTION } = require('./cognitive-lab-paired-delta');
const { lockBudgetEnvelope } = require('./cognitive-lab-budget-envelope');

const COMPARISON_SCHEMA_VERSION = 'huqan-cognitive-lab-comparison-v1';
const SPLITS = Object.freeze(['train', 'holdout', 'transfer']);
const VARIANTS = Object.freeze(['baseline', 'candidate']);
const MAX_TASKS = 2000;

class ComparisonContractError extends TypeError {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.code = code;
    this.path = path;
  }
}

function fail(path, message, code = 'comparison_invalid_field') {
  throw new ComparisonContractError(code, path, message);
}

function object(value, keys, path) {
  if (!isPlainObject(value)) fail(path, 'expected an object');
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required field is missing');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  return value;
}

function text(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || value.includes('\0')) {
    fail(path, 'expected a bounded non-empty identifier');
  }
  return value.trim();
}

function number(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `expected a finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeProtocol(input) {
  object(input, ['bins', 'minObserved', 'metricDirection', 'meaningfulEffect', 'nonInferiority', 'uncertainty'], 'protocol');
  if (input.metricDirection !== 'lower-is-better') fail('protocol.metricDirection', 'Brier and ECE are lower-is-better');
  if (!Number.isInteger(input.minObserved) || input.minObserved < MIN_OBSERVED_RECORDS || input.minObserved > MAX_TASKS) {
    fail('protocol.minObserved', `expected an integer from ${MIN_OBSERVED_RECORDS} to ${MAX_TASKS}`);
  }
  // Reuse the existing bin/minimum validator; an empty sample is not a score.
  calibrate([], { bins: input.bins, minObserved: input.minObserved });
  if (computeManifestDigest(input.bins) !== computeManifestDigest(ELEVEN_BINS)) fail('protocol.bins', 'paired measurement requires ELEVEN_BINS');
  object(input.nonInferiority, ['brier', 'ece'], 'protocol.nonInferiority');
  object(input.uncertainty, ['method', 'confidence', 'resamples'], 'protocol.uncertainty');
  if (input.uncertainty.method !== 'paired-bootstrap-percentile') fail('protocol.uncertainty.method', 'unsupported uncertainty method');
  if (!Number.isInteger(input.uncertainty.resamples) || input.uncertainty.resamples < 200 || input.uncertainty.resamples > 2000) {
    fail('protocol.uncertainty.resamples', 'expected an integer from 200 to 2000');
  }
  return {
    bins: [...input.bins], minObserved: input.minObserved, metricDirection: input.metricDirection,
    meaningfulEffect: number(input.meaningfulEffect, 'protocol.meaningfulEffect', Number.EPSILON, 1),
    nonInferiority: {
      brier: number(input.nonInferiority.brier, 'protocol.nonInferiority.brier', 0, 1),
      ece: number(input.nonInferiority.ece, 'protocol.nonInferiority.ece', 0, 1),
    },
    uncertainty: {
      method: input.uncertainty.method,
      confidence: number(input.uncertainty.confidence, 'protocol.uncertainty.confidence', 0.8, 0.99),
      resamples: input.uncertainty.resamples,
    },
  };
}

function pairedComparisonContract(manifest, split) {
  const { protocol, experiment } = manifest;
  return lockContract({
    method: BOOTSTRAP_METHOD, direction: DIRECTION,
    seed: parseInt(computeManifestDigest([experiment.seed, split]).slice(0, 8), 16),
    resamples: protocol.uncertainty.resamples, confidenceLevel: protocol.uncertainty.confidence,
    meaningfulEffect: protocol.meaningfulEffect, nonInferiorityMargin: protocol.nonInferiority.ece,
    minimumSamples: protocol.minObserved,
  });
}

function comparisonBudgetEnvelope(budget) {
  const calls = ['modelCalls', 'toolCalls', 'humanCalls'];
  for (const counter of calls) {
    if (budget[counter] !== null && !Number.isSafeInteger(budget[counter])) fail(`experiment.budget.${counter}`, 'safe integer call ceiling required');
  }
  if (budget.tokens === null || calls.some(counter => budget[counter] === null)) return null;
  const maxCallsPerArm = calls.reduce((sum, counter) => sum + budget[counter], 0);
  if (!Number.isSafeInteger(maxCallsPerArm)) fail('experiment.budget', 'aggregate call ceiling is out of range');
  return lockBudgetEnvelope({ maxTokensPerArm: budget.tokens, maxCallsPerArm, unit: 'tokens', overrunPolicy: 'reject' });
}

function normalizeTasks(tasks, experiment) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) fail('tasks', 'bounded task catalogue required');
  const ids = new Set();
  const events = new Set();
  const normalized = tasks.map((entry, index) => {
    const path = `tasks.${index}`;
    object(entry, ['taskId', 'sourceEventId', 'split'], path);
    const taskId = text(entry.taskId, `${path}.taskId`);
    const sourceEventId = text(entry.sourceEventId, `${path}.sourceEventId`);
    if (!SPLITS.includes(entry.split)) fail(`${path}.split`, 'unknown split');
    if (ids.has(taskId)) fail(`${path}.taskId`, 'duplicate task', 'comparison_duplication');
    if (events.has(sourceEventId)) fail(`${path}.sourceEventId`, 'correlated source event', 'comparison_duplication');
    ids.add(taskId);
    events.add(sourceEventId);
    return { taskId, sourceEventId, split: entry.split };
  }).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const split = Object.fromEntries(SPLITS.map(name => [name, normalized.filter(t => t.split === name).map(t => t.taskId)]));
  for (const name of SPLITS) {
    if (computeManifestDigest(split[name]) !== computeManifestDigest(experiment.split[name])) {
      fail(`experiment.split.${name}`, 'catalogue and split differ', 'comparison_leakage');
    }
  }
  if (experiment.split.identity !== computeManifestDigest(split)) fail('experiment.split.identity', 'split identity mismatch');
  if (experiment.fixture.digest !== computeManifestDigest(normalized)) fail('experiment.fixture.digest', 'task catalogue digest mismatch');
  return normalized;
}

function buildComparisonManifest(input) {
  object(input, ['schemaVersion', 'runId', 'experiment', 'variants', 'tasks', 'protocol'], 'comparison');
  if (input.schemaVersion !== COMPARISON_SCHEMA_VERSION) fail('schemaVersion', 'unknown schema');
  const runId = text(input.runId, 'runId');
  const { manifest: experiment } = buildManifest(input.experiment);
  for (const name of SPLITS) {
    if (input.experiment.split[name].length !== experiment.split[name].length) fail(`experiment.split.${name}`, 'duplicate split id', 'comparison_duplication');
  }
  if (experiment.source.repository !== experiment.frame.repository) fail('experiment.frame.repository', 'source/frame mismatch');
  const protocol = normalizeProtocol(input.protocol);
  if (experiment.thresholdConfigHash !== computeManifestDigest(protocol)) fail('experiment.thresholdConfigHash', 'protocol was not locked');
  object(input.variants, VARIANTS, 'variants');
  const variants = Object.fromEntries(VARIANTS.map(name => [name, text(input.variants[name], `variants.${name}`)]));
  const tasks = normalizeTasks(input.tasks, experiment);
  const manifest = freeze({ schemaVersion: COMPARISON_SCHEMA_VERSION, runId, experiment, variants, tasks, protocol });
  for (const split of ['holdout', 'transfer']) pairedComparisonContract(manifest, split);
  comparisonBudgetEnvelope(experiment.budget);
  return freeze({ manifest, digest: computeManifestDigest(manifest) });
}

function verifyComparisonManifest(design) {
  object(design, ['manifest', 'digest'], 'design');
  const built = buildComparisonManifest(design.manifest);
  if (typeof design.digest !== 'string' || built.digest !== design.digest) fail('digest', 'comparison digest mismatch', 'comparison_digest_mismatch');
  return built;
}

module.exports = {
  COMPARISON_SCHEMA_VERSION, SPLITS, VARIANTS, MAX_TASKS, ComparisonContractError,
  buildComparisonManifest, verifyComparisonManifest,
  pairedComparisonContract, comparisonBudgetEnvelope,
};
