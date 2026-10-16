'use strict';

// #3468 B5 preregistration. Frozen before any measurement: a change here must
// also change fixtures/cognitive-lab/world-model-design.json, which a test pins.
const DESIGN = Object.freeze({
  schemaVersion: 'huqan-world-model-experiment-v1',
  seed: 3468,
  world: 'bounded-door-multistep-v1',
  scope: 'Synthetic discrete multistep transitions in one frame; no external task, general planning or learning claim',
  split: { train: { prefix: 'train', count: 32 }, holdout: { prefix: 'holdout', count: 160 }, transfer: { prefix: 'transfer', count: 160 } },
  transfer: 'Unseen nuisance values and distinct episode/source ids; same causal law, frame and plan library',
  training: 'Each train state records one controlled treatment/control pair for energize, unjam, unlock and release; reset and force are never trained',
  budget: { modelCalls: 0, toolCalls: 0, humanCalls: 0, tokens: 0, maxTrainingEpisodes: 512, maxPlanSteps: 8, maxPlansCompared: 16, maxOperationsPerRollout: 100000 },
  baseline: {
    prediction: 'Persistence: the plan leaves the input state unchanged',
    modelFreePlanner: 'Cheapest receiver-policy-allowed plan from the same library, without a learned model',
    singleStepPlanner: 'I3 CausalSimulator.proposeActions over single library actions; cheapest supported candidate',
  },
  primary: {
    prediction: 'Full final-state accuracy of the case probe plan; UNKNOWN scores 0',
    planning: 'Goal reach of the selected plan executed in the environment',
  },
  thresholds: {
    minimumSamplesPerSplit: 160,
    minimumIndependentSupport: 3,
    minimumFinalStateAccuracyGain: 0.1,
    minimumGoalReachGain: 0.1,
    minimumGainLowerBound: 0.05,
    minimumMeanCostReductionVsSingleStep: 0.5,
    maximumFalseTransitions: 0,
    maximumFalseSuccess: 0,
    maximumUnsafeSelected: 0,
  },
  uncertainty: 'Conservative bounded synthetic case score: mean(delta)-sqrt(2*log(20)/n) on 0/1 outcomes; cost is reported as mean and per-case non-inferiority; no real-task population CI claim',
  metrics: {
    prediction: ['stepAccuracyOfPredictedSteps', 'falseTransitions', 'finalStateAccuracy', 'pairedFinalStateGain', 'unknownRate', 'untrainedStepAlwaysUnknown'],
    planning: ['goalReachRate', 'pairedGoalReachGain', 'falseSuccess', 'meanExecutedCost', 'costNonInferiorityVsSingleStep', 'unsafeSelected', 'plansCompared', 'rejectedAndUnknownAlternativesVisible'],
    calibration: 'NOT_MEASURED: the support score is not a probability; with zero false transitions a reliability curve has no information',
  },
  negativeControls: ['untrained step in a plan', 'policy-blocked step', 'support withdrawal between snapshots', 'operation budget exhaustion', 'fewer than two plans', 'no supported plan reaches the goal'],
  mutations: ['continue past an UNKNOWN step', 'skip the per-step policy check', 'disable the simulator Level 2 caller'],
  killCriteria: ['overlapping splits', 'fixture or environment digest mismatch', 'any false transition', 'any false success', 'unsafe plan selected', 'external call or token usage', 'lower bound below threshold', 'cost regression versus single-step planner'],
  promotion: 'No automatic model, plan or graph-rule promotion; KEEP is experimental only',
  phase: 'CONFIRMATORY_PREREGISTERED',
});

/** Seeded inputs only: states, nuisance values, probe plans and order. Never outcomes. */
function generateDataset(seed = DESIGN.seed, split = DESIGN.split) {
  let randomState = seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  // Probe plans exclude the policy-blocked plan: prediction is scored on plans a host could run.
  const probePlans = [0, 1, 2, 3, 4, 6];
  function cases(prefix, count, start) {
    const entries = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${seed}-${i}`,
      preState: { door: false, energized: i % 4 < 2, jammed: i % 2 === 0, nuisance: start + Math.floor(random() * 100000) },
      probePlan: probePlans[Math.floor(i / 4) % probePlans.length] }));
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    return entries;
  }
  return { train: cases('train', split.train.count, 0),
    splits: [{ name: 'holdout', cases: cases('holdout', split.holdout.count, 100000) }, { name: 'transfer', cases: cases('transfer', split.transfer.count, 1000000) }] };
}
// Recorded at preregistration from source a5f36885. The runner refuses to
// measure when the design, the generated inputs or the environment law drift.
const FROZEN = Object.freeze({
  designDigest: 'fbdbb3acd0e292df907ce55c95778704926920ee1cbecf6840d98bca7ecf8fdb',
  fixtureDigest: 'b99516ecf527ed4bd00eaa02d590c189e56babf8aa686c12fb21272b83fe64dc',
  worldDigest: '9e5b90501107ac53a7529ed3e62248fa2737cf87e00ddd9dcccbcc1002985b8f',
});
module.exports = { DESIGN, FROZEN, generateDataset };
