'use strict';

/**
 * Model-family comparison for B7 (#3474, I6; #3561).
 *
 * The port is model-agnostic; this module is the comparison the port makes
 * possible. It runs the *same* frozen design, the *same* inputs and the *same*
 * budget through every registered family -- SSM, RWKV, Mamba, Transformer -- and
 * reports quality, budget and locality side by side. Model-family choice is
 * inside B7 (the model-dependency benchmark), not a separate B mechanism, so
 * this composes the existing B7 runner rather than adding a second one.
 *
 * It measures; it promotes nothing. Every family answers through the candidate
 * port, so no arm here carries authority, and the comparison names a *best*
 * family only as an experimental ordering -- never a model to install, a memory
 * to admit or a rule to canonicalize.
 */

const { runNeuralCognitionExperiment } = require('./cognitive-lab-neural-experiment');
const { MODEL_AUTHORITY } = require('./cognitive-model-port');
const { digest } = require('./causal/causal-episode-contract');

const COMPARISON_SCHEMA_VERSION = 'huqan-cognitive-model-comparison-v1';

function mean(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }

/** One family's row: its measured quality per split, its budget and its locality. */
function familyRow(kind, result) {
  const quality = Object.fromEntries(result.reports.map((report) => [report.split, {
    candidateAccuracy: report.quality.candidateAccuracy,
    majorityAccuracy: report.quality.majorityAccuracy,
    memorylessAccuracy: report.quality.memorylessAccuracy,
    gainVsMajority: report.quality.gainVsMajority,
    gainVsMemoryless: report.quality.gainVsMemoryless,
  }]));
  return {
    kind,
    modelId: `local-${kind.toLowerCase()}`,
    status: result.status,
    quality,
    accuracy: mean(result.reports.map((report) => report.quality.candidateAccuracy)),
    budget: result.budget,
    locality: result.locality,
    authority: result.model.authority,
    canonical: result.model.canonical,
  };
}

/**
 * Run every registered family on one frozen experiment and compare them.
 *
 * @param {Object} options
 * @param {Record<string, (options: object) => object>} options.models kind -> model constructor
 * @param {string} options.sourceCommit 40-character Git SHA
 * @param {boolean} options.sourceDirty explicit source dirty state
 * @param {object} [options.design] frozen design (defaults to the shipped one)
 * @param {object} [options.dataset] frozen inputs (defaults to the generated ones)
 */
function compareModelFamilies({ models, sourceCommit, sourceDirty, design, dataset } = {}) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new TypeError('a model registry is required');
  const kinds = Object.keys(models).sort();
  if (kinds.length < 2) throw new TypeError('at least two model families are required to compare');
  for (const kind of kinds) if (typeof models[kind] !== 'function') throw new TypeError(`model constructor for ${kind} is required`);

  const runs = kinds.map((kind) => [kind, runNeuralCognitionExperiment({ createModel: models[kind], sourceCommit, sourceDirty, design, dataset })]);
  const families = runs.map(([kind, result]) => familyRow(kind, result));
  const designDigest = runs[0][1].designDigest;
  const fixtureDigest = runs[0][1].fixtureDigest;
  for (const [, result] of runs) {
    if (result.designDigest !== designDigest || result.fixtureDigest !== fixtureDigest) {
      throw new Error('model families did not run on the same frozen design and inputs');
    }
  }
  // Deterministic order: accuracy descending, then kind ascending, so a tie is
  // never broken by iteration order.
  const ranking = [...families].sort((a, b) => (b.accuracy - a.accuracy) || (a.kind < b.kind ? -1 : 1)).map((row) => ({ kind: row.kind, accuracy: row.accuracy }));
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    source: { commit: sourceCommit, dirty: sourceDirty },
    designDigest,
    fixtureDigest,
    families,
    ranking,
    best: ranking[0].kind,
    authority: MODEL_AUTHORITY,
    canonical: false,
    automaticPromotion: false,
    digest: digest(families),
    notMeasured: ['external tasks', 'calibration', 'language', 'vision', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B8'],
  };
}

module.exports = { compareModelFamilies, familyRow, COMPARISON_SCHEMA_VERSION };
