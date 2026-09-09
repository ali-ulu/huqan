'use strict';

const {
  createInitialState,
  ensureState,
  startFromDreamResult,
  advanceAfterVerification,
  isDreamExperimentVerificationStep,
  loopEnabled,
} = require('./dream-experiment-loop');

function prepareDreamExperiment({ active, state, workspaceId, goal, checkpointId, opts }) {
  if (!active) return null;
  const loopOptions = {
    workspaceId,
    goal,
    checkpointId,
    maxHypotheses: opts.dreamExperimentMaxHypotheses,
    maxCycles: opts.dreamExperimentMaxCycles,
    experimentId: opts.dreamExperimentId,
  };
  return state.dreamExperimentLoop
    ? ensureState(state.dreamExperimentLoop, loopOptions)
    : createInitialState(loopOptions);
}

function prepareDreamQueue(queue, state) {
  queue.length = 0;
  // H-03 (#1978) run tarafı makbuzu: plan() tarafındaki
  // stepsSupersededByLoop etiketiyle eşleşir.
  state.planSupersededByLoop = true;
  queue.unshift({
    id: `dream-experiment-dream-${state.steps.length + 1}`,
    action: 'dream',
    tool: 'dream',
    input: {},
    rationale: 'Dream experiment loop is enabled; generate a bounded hypothesis set before verification.',
  });
}

function processDreamStep(kernel, loopState, { step, report }, options) {
  const common = {
    workspaceId: options.workspaceId,
    goal: options.goal,
    checkpointId: options.checkpointId,
    maxHypotheses: options.maxHypotheses,
    maxCycles: options.maxCycles,
    experimentId: options.experimentId,
  };
  if (step.tool === 'dream') {
    return startFromDreamResult(kernel, loopState, report.result, common);
  }
  if (isDreamExperimentVerificationStep(step)) {
    return advanceAfterVerification(kernel, loopState, { step, ...report }, {
      ...common,
      admissionOpts: options.admissionOpts,
    });
  }
  return { state: loopState, handled: false, nextStep: null, blocked: false };
}

function selectDreamNextAction(enabled, state, fallback) {
  const nextAction = state.dreamExperimentLoop?.nextAction;
  return enabled && nextAction
    ? {
        action: nextAction,
        tool: nextAction === 'verify' ? 'verify' : nextAction,
        reason: state.dreamExperimentLoop.terminalReason || 'Dream experiment loop selected the next bounded action.',
      }
    : fallback;
}

// H-03 (#1978): loop etkinken run() plan adımlarını bounded dream
// cycle ile değiştirir. Plan çıktısı bunu etiketlemezse onay veren kullanıcı
// farklı işin çalıştığını görmez. Sözleşme (a): plan, loop niyetini açıkça
// etiketler; adımlar fallback olarak korunur, run ile aynı iş vaat edilmez.
function labelPlanDataForDreamLoop(data, opts, kernel, defaultEnabled) {
  const dreamLoopActive = loopEnabled(
    { ...opts, dreamExperimentLoop: opts.dreamExperimentLoop ?? defaultEnabled },
    kernel,
  );
  data.dreamExperimentLoop = { enabled: dreamLoopActive };
  if (dreamLoopActive) {
    data.executionMode = 'dream-experiment-loop';
    data.stepsSupersededByLoop = true;
    data.executionNote = 'Dream experiment loop is enabled; run() starts with a bounded dream cycle before legacy fallback steps.';
  } else {
    data.executionMode = 'plan-steps';
    data.stepsSupersededByLoop = false;
  }
  return dreamLoopActive;
}

module.exports = {
  // Re-exported so agent.v3.js can rehydrate a persisted loop on resume without
  // reaching past this adapter into lib/dream-experiment-loop.js directly.
  ensureState,
  loopEnabled,
  isDreamExperimentVerificationStep,
  prepareDreamExperiment,
  prepareDreamQueue,
  processDreamStep,
  selectDreamNextAction,
  labelPlanDataForDreamLoop,
};
