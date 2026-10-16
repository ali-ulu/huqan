'use strict';

const { CausalRuntime } = require('./causal/causal-runtime');
const { digest, stable } = require('./causal/causal-episode-contract');
const { buildManifest } = require('./cognitive-lab-manifest');
const { budgetUsageCheck, BUDGET_UNIT, OVERRUN_POLICY } = require('./cognitive-lab-budget-envelope');
const { gain } = require('./cognitive-lab-causal-experiment');
const { ACTIONS, TRAINED, PLANS, GOAL, FRAME, policy, executePlan, recordPair } = require('./cognitive-lab-world-model-world');
const { DESIGN, FROZEN, generateDataset } = require('./cognitive-lab-world-model-design');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash } = require('./content-hash');

function mean(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null; }
function allowed(plan) { return plan.every(step => policy({ action: step }).verdict === 'allow'); }
function reaches(preState, plan) { return Boolean(plan) && allowed(plan) && executePlan(preState, plan).at(-1).door === true; }
function cost(plan) { return plan.reduce((total, step) => total + step.cost, 0); }
const TRAINED_NAMES = new Set(TRAINED.map(step => step.name));
const MODEL_FREE_PLAN = PLANS.filter(allowed).sort((a, b) => cost(a) - cost(b))[0];

/** Score every predicted step of a rollout against the environment. */
function scoreRollout(preState, plan, rollout) {
  const actual = executePlan(preState, plan);
  const wrong = rollout.steps.filter((step, i) => stable(step.postState) !== stable(actual[i])).length;
  const falseSuccess = rollout.status === 'PREDICTED' && rollout.goalReached === true && actual.at(-1).door !== true;
  return { predictedSteps: rollout.steps.length, wrong, falseSuccess, actualFinal: actual.at(-1) };
}

function evaluateCase(simulator, item) {
  const probe = PLANS[item.probePlan];
  const roll = simulator.rolloutPlan({ preState: item.preState, plan: probe, desiredState: GOAL });
  const probeScore = scoreRollout(item.preState, probe, roll);
  const comparison = simulator.comparePlans({ preState: item.preState, desiredState: GOAL, plans: PLANS });
  const compared = comparison.alternatives.map(entry => scoreRollout(item.preState, entry.plan, entry.rollout));
  const selected = comparison.selected ? comparison.selected.plan : null;
  const inverse = simulator.proposeActions({ preState: item.preState, desiredState: GOAL, actions: Object.values(ACTIONS) });
  const single = inverse.candidates[0] ? [inverse.candidates[0].action] : null;
  const dispositions = new Set(comparison.alternatives.map(entry => entry.disposition));
  return { id: item.id, probePlan: item.probePlan, probeStatus: roll.status,
    finalCorrect: Number(roll.status === 'PREDICTED' && stable(roll.finalState) === stable(probeScore.actualFinal)),
    persistenceCorrect: Number(stable(item.preState) === stable(probeScore.actualFinal)),
    untrainedPredicted: [{ plan: probe, rollout: roll }, ...comparison.alternatives]
      .filter(entry => entry.rollout.steps.some(step => !TRAINED_NAMES.has(step.action.name))).length,
    predictedSteps: probeScore.predictedSteps + compared.reduce((total, entry) => total + entry.predictedSteps, 0),
    falseTransitions: probeScore.wrong + compared.reduce((total, entry) => total + entry.wrong, 0),
    falseSuccess: Number(probeScore.falseSuccess) + compared.filter(entry => entry.falseSuccess).length,
    selectedPlan: selected ? selected.map(step => step.name) : null, selectedCost: selected ? cost(selected) : null,
    candidateReached: Number(reaches(item.preState, selected)), unsafeSelected: Number(Boolean(selected) && !allowed(selected)),
    modelFreeReached: Number(reaches(item.preState, MODEL_FREE_PLAN)), modelFreeCost: cost(MODEL_FREE_PLAN),
    singleStepPlan: single ? single.map(step => step.name) : null, singleStepCost: single ? cost(single) : null,
    singleStepReached: Number(reaches(item.preState, single)),
    plansCompared: comparison.alternatives.length,
    rejectedVisible: dispositions.has('policy_rejected'), unknownVisible: dispositions.has('unknown') };
}

function splitReport(name, rows, thresholds) {
  const sum = key => rows.reduce((total, row) => total + Number(row[key]), 0);
  const predictionGain = gain(rows.map(row => row.persistenceCorrect), rows.map(row => row.finalCorrect));
  const planningGain = gain(rows.map(row => row.modelFreeReached), rows.map(row => row.candidateReached));
  const bothReached = rows.filter(row => row.candidateReached && row.singleStepReached);
  const costReduction = mean(bothReached.map(row => row.singleStepCost - row.selectedCost));
  const costRegressions = bothReached.filter(row => row.selectedCost > row.singleStepCost).length;
  const goalReach = mean(rows.map(row => row.candidateReached));
  const singleGoalReach = mean(rows.map(row => row.singleStepReached));
  const checks = {
    adequateSample: rows.length >= thresholds.minimumSamplesPerSplit,
    noFalseTransition: sum('falseTransitions') <= thresholds.maximumFalseTransitions,
    noFalseSuccess: sum('falseSuccess') <= thresholds.maximumFalseSuccess,
    noUnsafeSelected: sum('unsafeSelected') <= thresholds.maximumUnsafeSelected,
    untrainedNeverPredicted: sum('untrainedPredicted') === 0,
    alternativesVisible: rows.every(row => row.plansCompared >= 2 && row.rejectedVisible && row.unknownVisible),
    predictionGain: predictionGain.mean >= thresholds.minimumFinalStateAccuracyGain && predictionGain.lower95 >= thresholds.minimumGainLowerBound,
    planningGain: planningGain.mean >= thresholds.minimumGoalReachGain && planningGain.lower95 >= thresholds.minimumGainLowerBound,
    costVsSingleStep: costReduction !== null && costReduction >= thresholds.minimumMeanCostReductionVsSingleStep && costRegressions === 0 && goalReach >= singleGoalReach,
  };
  const safe = checks.noFalseTransition && checks.noFalseSuccess && checks.noUnsafeSelected && checks.untrainedNeverPredicted && checks.alternativesVisible;
  const status = !safe ? 'REJECT' : !checks.adequateSample ? 'INSUFFICIENT' : Object.values(checks).every(Boolean) ? 'KEEP' : 'REJECT';
  return { split: name, status, checks,
    prediction: { persistenceFinalStateAccuracy: mean(rows.map(row => row.persistenceCorrect)), candidateFinalStateAccuracy: mean(rows.map(row => row.finalCorrect)),
      gain: predictionGain, predictedSteps: sum('predictedSteps'), falseTransitions: sum('falseTransitions'),
      unknownRate: mean(rows.map(row => Number(row.probeStatus !== 'PREDICTED'))), untrainedPredicted: sum('untrainedPredicted'), calibration: 'NOT_MEASURED' },
    planning: { modelFreeGoalReach: mean(rows.map(row => row.modelFreeReached)), singleStepGoalReach: singleGoalReach, candidateGoalReach: goalReach,
      gain: planningGain, falseSuccess: sum('falseSuccess'), unsafeSelected: sum('unsafeSelected'),
      modelFreeMeanCost: mean(rows.map(row => row.modelFreeCost)), singleStepMeanCost: mean(bothReached.map(row => row.singleStepCost)),
      candidateMeanCost: mean(bothReached.map(row => row.selectedCost)), meanCostReductionVsSingleStep: costReduction, costRegressions,
      plansComparedPerCase: Math.min(...rows.map(row => row.plansCompared)) },
    cases: rows };
}

function validateRun({ design, dataset, sourceCommit, sourceDirty, createSimulator }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new TypeError('source commit required');
  if (typeof sourceDirty !== 'boolean') throw new TypeError('explicit source dirty state required');
  if (typeof createSimulator !== 'function') throw new TypeError('production simulator constructor required');
  if (design?.schemaVersion !== DESIGN.schemaVersion || design.world !== FRAME || !design.thresholds || !design.budget) throw new TypeError('world model experiment design required');
  const ids = [...dataset.train, ...dataset.splits.flatMap(split => split.cases)].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('overlapping splits');
}

/**
 * Real host flow: environment -> ExperienceJournal -> durable CausalRuntime ->
 * public CausalSimulator Level 1/2 -> policy -> environment outcome -> metrics.
 * KEEP needs the frozen preregistered design and inputs; anything else is at
 * most an unconfirmed run.
 */
/** The environment law the frozen record names, read as normalized UTF-8 source. */
function worldLawVerified() {
  const source = fs.readFileSync(path.join(__dirname, 'cognitive-lab-world-model-world.js'), 'utf8').replace(/\r\n/g, '\n');
  return contentHash(source) === FROZEN.worldDigest;
}

/** Any REJECT wins; KEEP needs frozen inputs and law, a clean source and every split KEEP. */
function overallStatus({ reports, frozenInputs, worldLaw, sourceDirty, equalExternalBudget }) {
  if (!equalExternalBudget || reports.some(item => item.status === 'REJECT')) return 'REJECT';
  if (!frozenInputs || !worldLaw || sourceDirty !== false || reports.some(item => item.status !== 'KEEP')) return 'INSUFFICIENT';
  return 'KEEP';
}

function runWorldModelExperiment({ graph, journal, createSimulator, sourceCommit, sourceDirty, design = DESIGN, dataset } = {}) {
  const inputs = dataset || generateDataset(design.seed, design.split);
  validateRun({ design, dataset: inputs, sourceCommit, sourceDirty, createSimulator });
  const frozenInputs = digest(design) === FROZEN.designDigest && digest(inputs) === FROZEN.fixtureDigest;
  const runtime = new CausalRuntime({ graph, journal, frameId: FRAME, evaluatePolicy: policy, minSupport: design.thresholds.minimumIndependentSupport });
  const simulator = createSimulator(graph, { causalRuntime: runtime });
  for (const item of inputs.train) for (const proposed of TRAINED) recordPair(journal, runtime, { id: `${item.id}-${proposed.name}`, preState: item.preState, action: proposed });
  const trainingEpisodes = runtime.inspect().episodes;
  if (trainingEpisodes > design.budget.maxTrainingEpisodes) throw new Error('training budget exceeded');
  const reports = inputs.splits.map(({ name, cases }) => splitReport(name, cases.map(item => evaluateCase(simulator, item)), design.thresholds));
  const externalBudget = budgetUsageCheck({ envelope: { maxTokensPerArm: 0, maxCallsPerArm: 0, unit: BUDGET_UNIT, overrunPolicy: OVERRUN_POLICY },
    baseline: { tokens: 0, calls: 0 }, candidate: { tokens: 0, calls: 0 } });
  const splitIds = Object.fromEntries([['train', inputs.train], ...inputs.splits.map(split => [split.name, split.cases])].map(([key, items]) => [key, items.map(item => item.id)]));
  const manifest = buildManifest({ schemaVersion: 'huqan-cognitive-lab-manifest-v1', source: { repository: 'ali-ulu/huqan', commit: sourceCommit, dirty: sourceDirty },
    fixture: { digest: digest(inputs) }, split: { identity: digest(splitIds), ...splitIds },
    frame: { repository: 'ali-ulu/huqan', branch: 'experiment', environment: FRAME, task: 'R13-B5' }, seed: design.seed,
    mechanisms: { B1: 'NOT_MEASURED', B2: 'NOT_MEASURED', B3: 'ENABLED', B4: 'NOT_MEASURED', B5: 'ENABLED', B6: 'NOT_MEASURED', B7: 'NOT_MEASURED', B8: 'NOT_MEASURED' },
    budget: { modelCalls: 0, toolCalls: 0, humanCalls: 0, tokens: 0, wallTimeMs: null, compute: null },
    measurementVersion: 'world-model-b5-v1', thresholdConfigHash: digest(design.thresholds) });
  const worldLaw = worldLawVerified();
  return { status: overallStatus({ reports, frozenInputs, worldLaw, sourceDirty, equalExternalBudget: externalBudget.assertsEqualBudget }),
    frozenInputsVerified: frozenInputs, worldLawVerified: worldLaw, scope: design.scope, designDigest: digest(design), fixtureDigest: digest(inputs),
    manifest: manifest.manifest, manifestDigest: manifest.digest, trainingEpisodes, externalBudget,
    measuredCompute: { equalActualCompute: 'NOT_MEASURED', note: 'the candidate evaluates every library plan; baselines evaluate fewer options' },
    reports, automaticPromotion: false,
    notMeasured: ['external tasks', 'calibration', 'stochastic transitions', 'plans outside the fixed library', 'B1', 'B2', 'B4', 'B6', 'B7', 'B8', 'equal actual CPU/wall-time'] };
}
module.exports = { runWorldModelExperiment, evaluateCase, splitReport, overallStatus };
