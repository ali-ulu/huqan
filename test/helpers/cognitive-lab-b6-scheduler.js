'use strict';

/**
 * B6 Cognitive Scheduler equal-budget ablation harness (#3311, program #3306).
 *
 * A #3311 measurement, not a production module: it lives under test/ so it adds
 * no shipped surface. It runs the *real* AgentV3 loop twice per task -- once
 * with the default FIFO plan order (baseline) and once with the opt-in
 * cognitive scheduler (candidate) -- at the same bounded budget, and reports a
 * paired solved-task delta over the holdout split, under a contract locked
 * before any outcome is scored.
 *
 * Why a bounded budget: `agent.v3.js` drains every plan step up to the
 * step/iteration/time ceiling, and the finalizer decides `completed` only from
 * an empty queue plus the last step's ok flag. A fully drained run is therefore
 * order-invariant; order can only change which steps run inside a *bounded*
 * prefix. Each task is planned with more steps than the run may execute
 * (`maxSteps = K` < plan length).
 *
 * Scoring follows the preregistration: a task is *solved* when the step it
 * registers as its solution (`solutionStepId`, the plan step id the objective
 * assigns that tool) executed within the budget -- not when any step merely
 * reused the tool name.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../../kernel');
const KernelV2 = require('../../kernel.v2');
const AgentV3 = require('../../agent.v3');
const { computeManifestDigest } = require('../../lib/cognitive-lab-manifest');

const BYPASS = Kernel.createAdmissionBypassOpts('i1-b6-ablation');

/** The candidate's opt-in configuration. Frozen here so both arms differ only by opt-in. */
const CANDIDATE_CONFIG = Object.freeze({ maxRiskTier: 'low', budget: 10 });

/**
 * The corpus. `solutionStepId` is the plan step id that objective assigns to
 * the tool that decides the task (see `lib/agent-planning-policy.js`), not just
 * a tool name; `split` assigns each task to train / transfer / holdout. The
 * holdout set is the primary measurement, because train and transfer are the
 * families the keyword signal is expected to favour.
 */
const TASKS = Object.freeze([
  // train: the keyword-relevance signal is expected to promote the solution.
  { taskId: 'verify-1', goal: 'verify risk manipulation', objective: 'verify', solutionStepId: 'verify', K: 2, split: 'train' },
  { taskId: 'verify-2', goal: 'doğrula çelişki risk', objective: 'verify', solutionStepId: 'verify', K: 2, split: 'train' },
  { taskId: 'compare-1', goal: 'compare kedi köpek', objective: 'compare', solutionStepId: 'compare', K: 2, split: 'train' },
  { taskId: 'compare-2', goal: 'karşılaştır kedi köpek', objective: 'compare', solutionStepId: 'compare', K: 2, split: 'train' },
  // transfer: different families, no keyword in the solution name.
  { taskId: 'reason-1', goal: 'neden gökyüzü mavi', objective: 'reason', solutionStepId: 'reason', K: 2, split: 'transfer' },
  { taskId: 'reason-2', goal: 'why is the sky blue', objective: 'reason', solutionStepId: 'reason', K: 2, split: 'transfer' },
  { taskId: 'investigate-1', goal: 'bu durumu incele', objective: 'investigate', solutionStepId: 'verify', K: 3, split: 'transfer' },
  { taskId: 'investigate-2', goal: 'genel durum nedir', objective: 'investigate', solutionStepId: 'verify', K: 3, split: 'transfer' },
  // holdout (primary): bidirectional and not the family the signal keys on.
  { taskId: 'compare-3', goal: 'compare iki seçenek', objective: 'compare', solutionStepId: 'compare', K: 2, split: 'holdout' },
  { taskId: 'learn-1', goal: 'öğren yeni kural', objective: 'learn', solutionStepId: 'ingest', K: 2, split: 'holdout' },
  { taskId: 'learn-2', goal: 'ekle yeni bilgi', objective: 'learn', solutionStepId: 'ingest', K: 2, split: 'holdout' },
  { taskId: 'dream-1', goal: 'hipotez üret', objective: 'dream', solutionStepId: 'dream', K: 2, split: 'holdout' },
  { taskId: 'dream-2', goal: 'dream hypothesis üret', objective: 'dream', solutionStepId: 'dream', K: 2, split: 'holdout' },
  { taskId: 'plan-1', goal: 'plan görev adım', objective: 'plan', solutionStepId: 'verify', K: 3, split: 'holdout' },
  { taskId: 'plan-2', goal: 'task workflow ajan', objective: 'plan', solutionStepId: 'verify', K: 3, split: 'holdout' },
  { taskId: 'question-1', goal: 'kedi hayvan mıdır?', objective: 'verify', solutionStepId: 'verify', K: 2, split: 'holdout' },
  { taskId: 'question-2', goal: 'bu doğru mudur?', objective: 'verify', solutionStepId: 'verify', K: 2, split: 'holdout' },
]);

/** Identity of the frozen corpus, so the measurement names exactly what it ran. */
const CORPUS_DIGEST = computeManifestDigest(TASKS.map((task) => ({
  taskId: task.taskId, objective: task.objective, solutionStepId: task.solutionStepId, K: task.K, split: task.split,
})));

function freshAgent(dir) {
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
  });
  kernel.learn('kedi hayvandır', BYPASS);
  return new AgentV3({
    kernel,
    dbPath: path.join(dir, 'memory.db'),
    maxSteps: 4,
    maxIterations: 4,
    timeBudgetMs: 5000,
    dreamExperimentLoop: false,
  });
}

/**
 * Run one task on one arm. Returns the executed step ids and actions, the run
 * status and how many steps ran (the real, observed budget consumption). The
 * temp store is closed and removed so a large corpus does not leak handles.
 */
function runArm(task, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-b6-'));
  const agent = freshAgent(dir);
  let run;
  try {
    run = agent.run(task.goal, {
      resume: false,
      maxSteps: task.K,
      maxIterations: 4,
      timeBudgetMs: 5000,
      ...opts,
    });
  } finally {
    try { if (agent.storage) agent.storage.close(); } catch (_) { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
  const steps = (run.data && run.data.steps) || [];
  return {
    taskId: task.taskId,
    order: steps.map((step) => step.action),
    stepIds: steps.map((step) => step.id),
    steps: steps.length,
    status: run.data && run.data.status,
  };
}

/**
 * A task is solved when its registered solution step executed within budget.
 * `executedStepIds` is the ordered list of step ids the arm actually ran; a
 * duplicate tool under a different step id does not count.
 */
function isSolved(task, executedStepIds) {
  return executedStepIds.includes(task.solutionStepId);
}

/** Run both arms for one task; the difference is only `opts.cognitiveScheduler`. */
function runTask(task) {
  const baseline = runArm(task, {});
  const candidate = runArm(task, { cognitiveScheduler: CANDIDATE_CONFIG });
  return {
    taskId: task.taskId,
    objective: task.objective,
    solutionStepId: task.solutionStepId,
    K: task.K,
    split: task.split,
    baseline,
    candidate,
    solvedBaseline: isSolved(task, baseline.stepIds) ? 1 : 0,
    solvedCandidate: isSolved(task, candidate.stepIds) ? 1 : 0,
  };
}

module.exports = {
  CANDIDATE_CONFIG, TASKS, CORPUS_DIGEST, runArm, runTask, isSolved,
};
