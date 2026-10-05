'use strict';

const { CausalRuntime } = require('./causal/causal-runtime');
const { digest, stable } = require('./causal/causal-episode-contract');
const { buildManifest } = require('./cognitive-lab-manifest');
const { budgetUsageCheck, BUDGET_UNIT, OVERRUN_POLICY } = require('./cognitive-lab-budget-envelope');
const { ACTIONS, FRAME, policy, execute, fixture, recordPair } = require('./cognitive-lab-causal-world');

function mean(values) { return values.reduce((total, value) => total + value, 0) / values.length; }
function gain(baseline, candidate) {
  const deltas = baseline.map((item, i) => candidate[i] - item);
  const value = mean(deltas);
  return { mean: value, lower95: value - Math.sqrt(2 * Math.log(20) / deltas.length), samples: deltas.length };
}
function validateDesign(design) {
  if (design?.schemaVersion !== 'huqan-causal-experiment-v1' || design.world !== FRAME || !Number.isInteger(design.seed) || design.seed < 1
    || design.split?.train?.prefix !== 'train' || design.split?.holdout?.prefix !== 'holdout' || design.split?.transfer?.prefix !== 'transfer') throw new TypeError('frozen causal experiment design required');
  for (const split of Object.values(design.split)) if (!Number.isInteger(split.count) || split.count < 1 || split.count > 10000) throw new TypeError('bounded split count required');
  if (!design.thresholds || !design.budget) throw new TypeError('thresholds and budget required');
}

/**
 * Real host flow: environment -> ExperienceJournal -> durable CausalRuntime ->
 * public CausalSimulator -> policy -> independent environment outcome -> metrics.
 * The environment function is used after prediction; it never trains on holdout.
 */
function runCausalExperiment({ graph, journal, createSimulator, design, sourceCommit, sourceDirty, dataset } = {}) {
  validateDesign(design);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new TypeError('source commit required');
  if (typeof sourceDirty !== 'boolean') throw new TypeError('explicit source dirty state required');
  if (typeof createSimulator !== 'function') throw new TypeError('production simulator constructor required');
  if (design.fixtureDigest && (!dataset || digest(dataset) !== design.fixtureDigest)) throw new Error('frozen fixture digest mismatch');
  const train = dataset ? dataset.train : fixture(design.seed, design.split.train.count, 'train');
  const splits = dataset ? dataset.splits : ['holdout', 'transfer'].map(name => ({ name, cases: fixture(design.seed, design.split[name].count, name) }));
  if (train.length !== design.split.train.count || splits.length !== 2 || new Set(splits.map(item => item.name)).size !== 2
    || splits.some(item => !['holdout', 'transfer'].includes(item.name) || item.cases.length !== design.split[item.name].count)) throw new Error('frozen fixture counts mismatch');
  const splitIds = { train: train.map(item => item.id), ...Object.fromEntries(splits.map(item => [item.name, item.cases.map(entry => entry.id)])) };
  const allIds = Object.values(splitIds).flat();
  if (new Set(allIds).size !== allIds.length) throw new Error('overlapping splits');
  const thresholds = design.thresholds;
  const runtime = new CausalRuntime({ graph, journal, frameId: FRAME, evaluatePolicy: policy,
    minSupport: thresholds.minimumIndependentSupport, maxOperations: design.budget.maxOperationsPerPrediction });
  const simulator = createSimulator(graph, { causalRuntime: runtime });
  for (const item of train) for (const proposed of ACTIONS.slice(1)) recordPair(journal, runtime, { ...item, id: `${item.id}-${proposed.name}`, action: proposed });
  const actualTrainingEpisodes = runtime.inspect().episodes;
  if (actualTrainingEpisodes > design.budget.maxTrainingEpisodes) throw new Error('training budget exceeded');
  const fixtureDigest = digest({ train, splits });
  const manifest = buildManifest({ schemaVersion: 'huqan-cognitive-lab-manifest-v1', source: { repository: 'ali-ulu/huqan', commit: sourceCommit, dirty: sourceDirty },
    fixture: { digest: fixtureDigest }, split: { identity: digest(splitIds), ...splitIds },
    frame: { repository: 'ali-ulu/huqan', branch: 'experiment', environment: FRAME, task: 'R12-B2-B3' }, seed: design.seed,
    mechanisms: { B1: 'NOT_MEASURED', B2: 'ENABLED', B3: 'ENABLED', B4: 'NOT_MEASURED', B5: 'NOT_MEASURED', B6: 'NOT_MEASURED', B7: 'NOT_MEASURED', B8: 'NOT_MEASURED' },
    budget: { modelCalls: 0, toolCalls: 0, humanCalls: 0, tokens: 0, wallTimeMs: null, compute: null },
    measurementVersion: 'causal-b2-b3-v1', thresholdConfigHash: digest(thresholds) });
  const reports = [];
  for (const { name, cases } of splits) {
    const baseAccuracy = []; const candidateAccuracy = []; const baseGoal = []; const candidateGoal = [];
    const baseCosts = []; const candidateCosts = []; const details = [];
    let unknowns = 0; let falseEffects = 0; let assertedEffects = 0; let unsafeRejected = 0; let unsafeSelected = 0;
    let baselineSlots = 0; let candidateSlots = 0; let candidateOperations = 0;
    for (const item of cases) {
      baselineSlots++;
      candidateSlots++;
      const prediction = simulator.predictTransition({ preState: item.preState, action: item.action });
      candidateOperations += prediction.operations || 0;
      const actual = execute(item.preState, item.action);
      baseAccuracy.push(Number(stable(item.preState) === stable(actual)));
      candidateAccuracy.push(Number(prediction.status === 'PREDICTED' && stable(prediction.postState) === stable(actual)));
      if (prediction.status !== 'PREDICTED') unknowns++;
      else if (Object.keys(prediction.effect).length) {
        assertedEffects++;
        if (stable(prediction.postState) !== stable(actual)) falseEffects++;
      }
      const permitted = ACTIONS.filter(proposed => policy({ action: proposed }).verdict === 'allow');
      baselineSlots += ACTIONS.length;
      candidateSlots += ACTIONS.length;
      const baselineAction = permitted.sort((a, b) => a.cost - b.cost)[0];
      const inverse = simulator.proposeActions({ preState: item.preState, desiredState: { door: true }, actions: ACTIONS });
      unsafeRejected += inverse.rejected.filter(entry => entry.action.name === 'force').length;
      const chosen = inverse.candidates[0]?.action || null;
      if (chosen && policy({ action: chosen }).verdict !== 'allow') unsafeSelected++;
      baseGoal.push(Number(execute(item.preState, baselineAction).door === true));
      candidateGoal.push(Number(chosen && policy({ action: chosen }).verdict === 'allow' && execute(item.preState, chosen).door === true));
      baseCosts.push(baselineAction.cost); candidateCosts.push(chosen ? chosen.cost : 0);
      for (const candidate of inverse.candidates) candidateOperations += candidate.prediction.operations || 0;
      details.push({ id: item.id, predictionStatus: prediction.status, modelId: prediction.modelId || null,
        baselineReached: baseGoal.at(-1), candidateReached: candidateGoal.at(-1), selectedAction: chosen?.name || null });
    }
    const equalBudget = budgetUsageCheck({ envelope: { maxTokensPerArm: 0, maxCallsPerArm: cases.length * design.budget.maxPredictionsPerCase, unit: BUDGET_UNIT, overrunPolicy: OVERRUN_POLICY },
      baseline: { tokens: 0, calls: baselineSlots }, candidate: { tokens: 0, calls: candidateSlots } });
    const b2Gain = gain(baseAccuracy, candidateAccuracy); const b3Gain = gain(baseGoal, candidateGoal);
    const falseRate = assertedEffects ? falseEffects / assertedEffects : null;
    const adequate = cases.length >= thresholds.minimumSamplesPerSplit;
    const keep = adequate && equalBudget.assertsEqualBudget && falseRate !== null && falseRate <= thresholds.maximumFalseCausalRuleRate
      && unsafeSelected <= thresholds.maximumUnsafeSelected && unsafeRejected === cases.length
      && b2Gain.mean >= thresholds.minimumAccuracyGain && b3Gain.mean >= thresholds.minimumGoalReachGain
      && b2Gain.lower95 >= thresholds.minimumGainLowerBound && b3Gain.lower95 >= thresholds.minimumGainLowerBound;
    reports.push({ split: name, status: !adequate ? 'INSUFFICIENT' : keep ? 'KEEP' : 'REJECT',
      B2: { baselineAccuracy: mean(baseAccuracy), candidateAccuracy: mean(candidateAccuracy), gain: b2Gain,
        falseCausalRuleRate: falseRate, falseCausalEffects: falseEffects, assertedCausalEffects: assertedEffects, unknownRate: unknowns / cases.length },
      B3: { baselineGoalReach: mean(baseGoal), candidateGoalReach: mean(candidateGoal), gain: b3Gain,
        baselineMeanExecutedCost: mean(baseCosts), candidateMeanExecutedCost: mean(candidateCosts), unsafeRejections: unsafeRejected, unsafeSelected },
      budget: equalBudget, measuredCompute: { baselinePredictionSlots: baselineSlots, candidatePredictionSlots: candidateSlots,
        candidateLearnedOperations: candidateOperations, equalActualCompute: 'NOT_MEASURED', unit: 'prediction_or_action_evaluation_slot' },
      cases: details });
  }
  return { status: reports.every(item => item.status === 'KEEP') ? 'KEEP' : reports.some(item => item.status === 'INSUFFICIENT') ? 'INSUFFICIENT' : 'REJECT',
    scope: design.scope, designDigest: digest(design), fixtureDigest, manifest: manifest.manifest, manifestDigest: manifest.digest,
    trainingEpisodes: actualTrainingEpisodes, reports, automaticPromotion: false,
    notMeasured: ['external tasks', 'multi-step planning', 'B1', 'B4', 'B5', 'B6', 'B7', 'B8', 'equal actual CPU/wall-time'] };
}
module.exports = { runCausalExperiment, validateDesign, gain };
