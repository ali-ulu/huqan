'use strict';

// The CLI holds its isolated-state lock across each operation. This adapter
// reuses Graph's journal; it is not a second prediction/outcome authority.
const { isPlainObject } = require('./is-plain-object');
const { computeManifestDigest } = require('./cognitive-lab-manifest');
const { buildComparisonManifest, verifyComparisonManifest, VARIANTS } = require('./cognitive-lab-comparison-contract');
const { COUNTERS, compareCalibration } = require('./cognitive-lab-comparison');
const { PAIR_OPERATION_PREFIX, OUTCOMES, recordPrediction, recordOutcome, readPredictionPairs } = require('./prediction-outcome-pairs');
const {
  PROBABILITY_OPERATION_PREFIX, recordDecisionProbability, readCalibratedRecords,
} = require('./cognitive-lab-probability-calibration');

const PREFIX = 'cognitive-lab-comparison:';

function exact(input, keys) {
  if (!isPlainObject(input) || keys.some(k => !Object.hasOwn(input, k))
    || Object.keys(input).some(k => !keys.includes(k))) throw new TypeError(`expected only ${keys.join(', ')}`);
}

function runKey(runId) {
  if (typeof runId !== 'string' || !runId.trim() || runId !== runId.trim()
    || runId.length > 128 || runId.includes('\0')) throw new TypeError('invalid runId');
  return `${PREFIX}${computeManifestDigest(runId)}`;
}

function read(graph, id) {
  if (!graph || typeof graph.getCommittedMutationResultByOperation !== 'function') throw new TypeError('durable Graph required');
  return graph.getCommittedMutationResultByOperation(id)?.result ?? null;
}

function commit(graph, id, payload) {
  const previous = read(graph, id);
  if (previous && computeManifestDigest(previous) !== computeManifestDigest(payload)) throw new Error('frozen record differs');
  const result = graph.runMutationOnce(id, () => payload);
  const committed = read(graph, id);
  if (!committed || computeManifestDigest(committed) !== computeManifestDigest(payload)) throw new Error('record was not committed');
  return { replayed: Boolean(result.replayed) };
}

function load(graph, runId) {
  const entry = read(graph, `${runKey(runId)}:design`);
  if (!entry || entry.comparisonDesign !== true) throw new Error('unknown comparison run');
  const design = verifyComparisonManifest(entry.design);
  if (design.manifest.runId !== runId) throw new Error('comparison run identity differs');
  return design;
}

function decisionId(runId, taskId) {
  return `cognitive-calibration:${computeManifestDigest([runId, taskId])}`;
}

function measurementId(runId, variant) {
  return `cognitive-calibration:${computeManifestDigest([runId, variant])}`;
}

function task(design, taskId) {
  const found = design.manifest.tasks.find(t => t.taskId === taskId && t.split !== 'train');
  if (!found) throw new TypeError('unknown or train task');
  return found;
}

function variantId(variant) {
  if (!VARIANTS.includes(variant)) throw new TypeError('unknown variant');
  return variant;
}

function budgetKey(runId, variant) { return `${runKey(runId)}:budget:${variantId(variant)}`; }

// Legacy pair reads deliberately return [] on failure. Read both prefixes here
// first and give those helpers a checked snapshot, so a failed read cannot
// turn an already-observed outcome into permission for a new forecast.
function snapshot(graph) {
  const rows = new Map([PAIR_OPERATION_PREFIX, PROBABILITY_OPERATION_PREFIX].map(prefix => {
    const value = graph.getCommittedMutationResultsByPrefix(prefix);
    if (!Array.isArray(value)) throw new Error('ledger read did not return rows');
    return [prefix, value];
  }));
  return {
    runMutationOnce: graph.runMutationOnce.bind(graph),
    getCommittedMutationResultsByPrefix(prefix) {
      if (!rows.has(prefix)) throw new Error('unexpected ledger prefix');
      return rows.get(prefix);
    },
  };
}

function prepareComparison(graph, input) {
  const design = buildComparisonManifest(input);
  const { runId, tasks } = design.manifest;
  const result = commit(graph, `${runKey(runId)}:design`, { comparisonDesign: true, design });
  for (const entry of tasks.filter(t => t.split !== 'train')) {
    const id = decisionId(runId, entry.taskId);
    recordPrediction(graph, { decisionId: id, unknown: 'explicit_probability_recorded_separately', actionClass: 'calibration' });
    if (!read(graph, `${PAIR_OPERATION_PREFIX}prediction:${id}`)?.prediction) throw new Error('prediction was not committed');
  }
  return { ...result, runId, designDigest: design.digest };
}

function recordComparisonForecast(graph, input) {
  exact(input, ['runId', 'variant', 'taskId', 'probability']);
  const { runId, variant, taskId, probability } = input;
  const design = load(graph, runId);
  task(design, taskId);
  variantId(variant);
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new TypeError('invalid probability');
  const id = decisionId(runId, taskId);
  const mid = measurementId(runId, variant);
  const port = snapshot(graph);
  const prior = readCalibratedRecords(port, { measurementId: mid }).find(r => r.decisionId === id);
  if (prior && prior.probability !== probability) throw new Error('frozen probability differs');
  if (!prior && read(graph, budgetKey(runId, variant))) throw new Error('variant budget is sealed');
  const result = recordDecisionProbability(port, { measurementId: mid, decisionId: id, probability });
  const actual = readCalibratedRecords(snapshot(graph), { measurementId: mid }).find(r => r.decisionId === id);
  if (!actual || actual.probability !== probability) throw new Error('forecast was not committed');
  return { replayed: result.replayed, runId, variant, taskId, probability };
}

function recordComparisonOutcome(graph, input) {
  exact(input, ['runId', 'taskId', 'outcome']);
  const { runId, taskId, outcome } = input;
  task(load(graph, runId), taskId);
  if (!OUTCOMES.includes(outcome)) throw new TypeError('unknown outcome');
  const id = decisionId(runId, taskId);
  const port = snapshot(graph);
  const pair = readPredictionPairs(port, { decisionId: id })[id];
  if (pair?.outcome && pair.outcome.state !== outcome) throw new Error('frozen outcome differs');
  const result = recordOutcome(port, { decisionId: id, outcome, idempotencyKey: id });
  const actual = readPredictionPairs(snapshot(graph), { decisionId: id })[id];
  if (!actual?.outcome || actual.outcome.state !== outcome) throw new Error('outcome was not committed');
  return { replayed: result.replayed, runId, taskId, outcome };
}

function recordComparisonBudget(graph, input) {
  exact(input, ['runId', 'variant', 'envelope', 'usage']);
  const { runId, variant, envelope, usage } = input;
  const design = load(graph, runId);
  variantId(variant);
  exact(usage, COUNTERS);
  const entry = { envelope, usage };
  const check = compareCalibration({ design, baseline: [], candidate: [], budgets: { baseline: entry, candidate: entry } });
  if (check.status === 'REJECT') throw new TypeError(`budget rejected: ${check.reason}`);
  return { ...commit(graph, budgetKey(runId, variant), entry), runId, variant, usageEvidence: 'CALLER_REPORTED' };
}

function reportComparison(graph, input) {
  exact(input, ['runId']);
  const { runId } = input;
  const design = load(graph, runId);
  const port = snapshot(graph);
  const variants = Object.fromEntries(VARIANTS.map(variant => {
    const rows = new Map(readCalibratedRecords(port, { measurementId: measurementId(runId, variant) }).map(r => [r.decisionId, r]));
    return [variant, design.manifest.tasks.filter(t => t.split !== 'train').map(t => {
      const row = rows.get(decisionId(runId, t.taskId));
      return row ? { ...row, decisionId: t.taskId } : { decisionId: t.taskId, status: 'missing' };
    })];
  }));
  const budgets = Object.fromEntries(VARIANTS.map(variant => [variant, read(graph, budgetKey(runId, variant))]));
  const result = compareCalibration({ design, ...variants, budgets });
  return { ...result, runId, correctnessDigest: computeManifestDigest(result) };
}

module.exports = { prepareComparison, readComparisonDesign: load, recordComparisonForecast, recordComparisonOutcome, recordComparisonBudget, reportComparison };
