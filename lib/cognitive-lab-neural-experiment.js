'use strict';

/**
 * #3474 B7 measurement orchestration (I6).
 *
 * The real host flow: the frozen inputs feed a local SSM candidate and two
 * declared baselines, the environment law (lib/cognitive-lab-neural-world.js)
 * is consulted only to produce labels and outcomes, and the metrics separate
 * quality, budget and locality. The candidate is a proposal through
 * lib/cognitive-model-port.js -- CANDIDATE_ONLY, canonical:false -- so no arm
 * here can carry authority.
 *
 * The runner measures; it does not promote. KEEP needs the frozen design and
 * inputs, the frozen environment law, a clean source, an equal external budget
 * and every split KEEP. A missing freeze is at most INSUFFICIENT, and any
 * REJECT wins over INSUFFICIENT so a safety failure cannot hide behind a small
 * sample.
 */

const fs = require('node:fs');
const path = require('node:path');
const { digest, stable } = require('./causal/causal-episode-contract');
const { contentHash } = require('./content-hash');
const { buildManifest } = require('./cognitive-lab-manifest');
const { budgetUsageCheck, BUDGET_UNIT, OVERRUN_POLICY } = require('./cognitive-lab-budget-envelope');
const { createLocalNeuralModel } = require('./cognitive-model-local-ssm');
const { validateProposal, MODEL_AUTHORITY } = require('./cognitive-model-port');
const { FRAME, STEPS, label } = require('./cognitive-lab-neural-world');
const { DESIGN, FROZEN, generateDataset } = require('./cognitive-lab-neural-design');

function mean(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }

/** The same conservative lower bound the causal experiments use. */
function gain(baseline, candidate) {
  const deltas = baseline.map((item, index) => candidate[index] - item);
  const value = mean(deltas);
  return { mean: value, lower95: value - Math.sqrt(2 * Math.log(20) / deltas.length), samples: deltas.length };
}

function majorityLabel(trainCases) {
  const positives = trainCases.filter((item) => label(item.sequence) === 1).length;
  return positives * 2 >= trainCases.length ? 1 : 0;
}

function memorylessLabel(sequence) {
  return sequence[sequence.length - 1] === 1 ? 1 : 0;
}

function evaluateCase(model, item) {
  const proposal = model.predict(item.sequence);
  const valid = validateProposal(proposal);
  const expected = label(item.sequence);
  const predicted = proposal.answer.label === 'positive' ? 1 : 0;
  return {
    id: item.id,
    predicted,
    expected,
    correct: Number(predicted === expected),
    memorylessCorrect: Number(memorylessLabel(item.sequence) === expected),
    falsePositive: Number(predicted === 1 && expected === 0),
    falseNegative: Number(predicted === 0 && expected === 1),
    confidence: proposal.confidence,
    finiteScore: Number(Number.isFinite(proposal.answer.score)),
    valid: Number(valid.status === 'VALID'),
    authority: proposal.authority,
    canonical: proposal.canonical,
  };
}

function splitReport(name, rows, thresholds) {
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key]), 0);
  const qualityGain = gain(rows.map((row) => Number(row.majorityCorrect)), rows.map((row) => row.correct));
  const memorylessGain = gain(rows.map((row) => row.memorylessCorrect), rows.map((row) => row.correct));
  const checks = {
    adequateSample: rows.length >= thresholds.minimumSamplesPerSplit,
    allValid: rows.every((row) => row.valid === 1 && row.authority === MODEL_AUTHORITY && row.canonical === false),
    finiteScores: rows.every((row) => row.finiteScore === 1),
    minimumQuality: mean(rows.map((row) => row.correct)) >= thresholds.minimumQuality,
    gainVsMajority: qualityGain.mean >= thresholds.minimumAccuracyGain && qualityGain.lower95 >= thresholds.minimumGainLowerBound,
    gainVsMemoryless: memorylessGain.mean >= thresholds.minimumAccuracyGain && memorylessGain.lower95 >= thresholds.minimumGainLowerBound,
  };
  const safe = checks.allValid && checks.finiteScores;
  const status = !safe ? 'REJECT' : !checks.adequateSample ? 'INSUFFICIENT'
    : Object.values(checks).every(Boolean) ? 'KEEP' : 'REJECT';
  return {
    split: name,
    status,
    checks,
    quality: {
      candidateAccuracy: mean(rows.map((row) => row.correct)),
      majorityAccuracy: mean(rows.map((row) => Number(row.majorityCorrect))),
      memorylessAccuracy: mean(rows.map((row) => row.memorylessCorrect)),
      gainVsMajority: qualityGain,
      gainVsMemoryless: memorylessGain,
      falsePositives: sum('falsePositive'),
      falseNegatives: sum('falseNegative'),
      meanConfidence: mean(rows.map((row) => row.confidence)),
      calibration: 'NOT_MEASURED',
    },
    cases: rows,
  };
}

function validateRun({ design, dataset, sourceCommit, sourceDirty, createModel }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new TypeError('source commit required');
  if (typeof sourceDirty !== 'boolean') throw new TypeError('explicit source dirty state required');
  if (typeof createModel !== 'function') throw new TypeError('production model constructor required');
  if (design?.schemaVersion !== DESIGN.schemaVersion || design.world !== FRAME || !design.thresholds || !design.budget || !design.model) {
    throw new TypeError('neural cognition experiment design required');
  }
  const ids = [...dataset.train, ...dataset.splits.flatMap((split) => split.cases)].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('overlapping splits');
}

/** The environment law the frozen record names, read as normalized UTF-8 source. */
function worldLawVerified() {
  const source = fs.readFileSync(path.join(__dirname, 'cognitive-lab-neural-world.js'), 'utf8').replace(/\r\n/g, '\n');
  return contentHash(source) === FROZEN.worldDigest;
}

/** Any REJECT wins; KEEP needs frozen inputs and law, a clean source and every split KEEP. */
function overallStatus({ reports, frozenInputs, worldLaw, sourceDirty, equalExternalBudget }) {
  if (!equalExternalBudget || reports.some((item) => item.status === 'REJECT')) return 'REJECT';
  if (!frozenInputs || !worldLaw || sourceDirty !== false || reports.some((item) => item.status !== 'KEEP')) return 'INSUFFICIENT';
  return 'KEEP';
}

function runNeuralCognitionExperiment({ createModel, sourceCommit, sourceDirty, design = DESIGN, dataset } = {}) {
  const inputs = dataset || generateDataset(design.seed, design.split);
  validateRun({ design, dataset: inputs, sourceCommit, sourceDirty, createModel });
  const frozenInputs = digest(design) === FROZEN.designDigest && digest(inputs) === FROZEN.fixtureDigest;

  const model = createModel({ seed: design.model.seed, reservoir: design.model.reservoir, ridge: design.model.ridge, steps: design.model.steps });
  if (inputs.train.length > design.budget.maxTrainingSamples) throw new Error('training budget exceeded');
  const training = inputs.train.map((item) => ({ sequence: item.sequence, label: label(item.sequence) === 1 ? 1 : -1 }));
  model.train(training);
  const description = model.describe();
  if (description.locality !== 'LOCAL') throw new Error('local model required');
  const parameters = description.reservoir * description.reservoir + description.reservoir * 2 + description.reservoir + 1;
  if (parameters > design.budget.maxParameters) throw new Error('parameter budget exceeded');

  const majority = majorityLabel(inputs.train);
  const reports = inputs.splits.map(({ name, cases }) => splitReport(name,
    cases.map((item) => ({ ...evaluateCase(model, item), majorityCorrect: Number(majority === label(item.sequence)) })), design.thresholds));

  const externalBudget = budgetUsageCheck({ envelope: { maxTokensPerArm: 0, maxCallsPerArm: 0, unit: BUDGET_UNIT, overrunPolicy: OVERRUN_POLICY },
    baseline: { tokens: 0, calls: 0 }, candidate: { tokens: 0, calls: 0 } });
  const splitIds = Object.fromEntries([['train', inputs.train], ...inputs.splits.map((split) => [split.name, split.cases])]
    .map(([key, items]) => [key, items.map((item) => item.id)]));
  const manifest = buildManifest({ schemaVersion: 'huqan-cognitive-lab-manifest-v1', source: { repository: 'ali-ulu/huqan', commit: sourceCommit, dirty: sourceDirty },
    fixture: { digest: digest(inputs) }, split: { identity: digest(splitIds), ...splitIds },
    frame: { repository: 'ali-ulu/huqan', branch: 'experiment', environment: FRAME, task: 'R19-B7' }, seed: design.seed,
    mechanisms: { B1: 'NOT_MEASURED', B2: 'NOT_MEASURED', B3: 'NOT_MEASURED', B4: 'NOT_MEASURED', B5: 'NOT_MEASURED', B6: 'NOT_MEASURED', B7: 'ENABLED', B8: 'NOT_MEASURED' },
    budget: { modelCalls: 0, toolCalls: 0, humanCalls: 0, tokens: 0, wallTimeMs: null, compute: null },
    measurementVersion: 'neural-cognition-b7-v1', thresholdConfigHash: digest(design.thresholds) });

  const operations = reports.reduce((total, report) => total + report.cases.length * description.reservoir * description.reservoir * description.steps, 0);
  if (operations > design.budget.maxOperationsPerPrediction * reports.reduce((total, report) => total + report.cases.length, 0)) {
    throw new Error('operation budget exceeded');
  }
  const worldLaw = worldLawVerified();
  return {
    status: overallStatus({ reports, frozenInputs, worldLaw, sourceDirty, equalExternalBudget: externalBudget.assertsEqualBudget }),
    frozenInputsVerified: frozenInputs, worldLawVerified: worldLaw, scope: design.scope,
    designDigest: digest(design), fixtureDigest: digest(inputs), manifest: manifest.manifest, manifestDigest: manifest.digest,
    model: Object.freeze({ ...description, parameters, trainingSamples: model.trainingSamples, authority: MODEL_AUTHORITY, canonical: false }),
    budget: Object.freeze({ modelCalls: 0, tokens: 0, operations, parameters, trainingSamples: model.trainingSamples }),
    locality: Object.freeze({ locality: description.locality, externalCalls: 0 }),
    externalBudget, reports, automaticPromotion: false,
    notMeasured: ['external tasks', 'calibration', 'RWKV/Mamba/Transformer comparison', 'language', 'vision', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B8'],
  };
}

module.exports = { runNeuralCognitionExperiment, evaluateCase, splitReport, overallStatus, gain, stable };
