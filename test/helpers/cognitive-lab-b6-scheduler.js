'use strict';

/**
 * B6 Cognitive Scheduler equal-budget ablation harness (#3311, program #3306).
 *
 * A #3311 measurement, not a production module: it lives under test/ so it adds
 * no shipped surface. It runs the *real* AgentV3 loop twice per task -- once
 * with the default FIFO plan order (baseline) and once with the opt-in
 * cognitive scheduler (candidate) -- at the same bounded budget, and reports a
 * paired solved-task delta under a contract that is locked before any outcome
 * is scored.
 *
 * Why a bounded budget: `agent.v3.js` drains every plan step up to the
 * step/iteration/time ceiling, and the finalizer decides `completed` only from
 * an empty queue plus the last step's ok flag. A fully drained run is therefore
 * order-invariant; order can only change which steps run inside a *bounded*
 * prefix. So each task is planned with more steps than the run may execute
 * (`maxSteps = K` < plan length), and a task is *solved* when every tool its
 * objective requires is executed within that prefix.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../../kernel');
const KernelV2 = require('../../kernel.v2');
const AgentV3 = require('../../agent.v3');

const BYPASS = Kernel.createAdmissionBypassOpts('i1-b6-ablation');

/** The candidate's opt-in configuration. Frozen here so both arms differ only by opt-in. */
const CANDIDATE_CONFIG = Object.freeze({ maxRiskTier: 'low', budget: 10 });

/**
 * The frozen task corpus. Each task names the goal, the objective it lands on
 * (`lib/agent-planning-policy.js`), the tools that objective's plan requires to
 * count as solved, and the bounded budget K. The set spans the objectives and
 * has no fixed direction of benefit: some objectives require `verify` (which
 * the keyword-relevance signal promotes), others `learn` (which it does not),
 * so the scheduler is not trivially favoured.
 */
const TASKS = Object.freeze([
  // verify-family: solution is `verify`, which the goal keyword boosts.
  { taskId: 'verify-1', goal: 'verify risk manipulation', objective: 'verify', required: ['verify'], K: 2 },
  { taskId: 'verify-2', goal: 'doğrula çelişki risk', objective: 'verify', required: ['verify'], K: 2 },
  { taskId: 'verify-3', goal: 'kontrol et risk manipulation', objective: 'verify', required: ['verify'], K: 2 },
  { taskId: 'verify-4', goal: 'verify çelişki doğrula', objective: 'verify', required: ['verify'], K: 2 },
  // ask-led families: solution is a non-ask tool the keyword signal may push aside.
  { taskId: 'compare-1', goal: 'compare kedi köpek', objective: 'compare', required: ['compare'], K: 2 },
  { taskId: 'compare-2', goal: 'karşılaştır kedi köpek', objective: 'compare', required: ['compare'], K: 2 },
  { taskId: 'compare-3', goal: 'compare iki seçenek', objective: 'compare', required: ['compare'], K: 2 },
  { taskId: 'reason-1', goal: 'neden gökyüzü mavi', objective: 'reason', required: ['reason'], K: 2 },
  { taskId: 'reason-2', goal: 'why is the sky blue', objective: 'reason', required: ['reason'], K: 2 },
  { taskId: 'reason-3', goal: 'niçin düşüyor cisim', objective: 'reason', required: ['reason'], K: 2 },
  // learn: solution is `learn`, which the keyword signal does not boost.
  { taskId: 'learn-1', goal: 'öğren yeni kural', objective: 'learn', required: ['learn'], K: 2 },
  { taskId: 'learn-2', goal: 'ekle yeni bilgi', objective: 'learn', required: ['learn'], K: 2 },
  { taskId: 'learn-3', goal: 'learn a new fact', objective: 'learn', required: ['learn'], K: 2 },
  // dream: solution is `dream`, the fallback tool.
  { taskId: 'dream-1', goal: 'hipotez üret', objective: 'dream', required: ['dream'], K: 2 },
  { taskId: 'dream-2', goal: 'dream hypothesis üret', objective: 'dream', required: ['dream'], K: 2 },
  { taskId: 'dream-3', goal: 'fikir üret öner', objective: 'dream', required: ['dream'], K: 2 },
  // plan: requires both ask and verify (a two-tool requirement inside K=3).
  { taskId: 'plan-1', goal: 'plan görev adım', objective: 'plan', required: ['ask', 'verify'], K: 3 },
  { taskId: 'plan-2', goal: 'task workflow ajan', objective: 'plan', required: ['ask', 'verify'], K: 3 },
  { taskId: 'plan-3', goal: 'görev plan workflow yap', objective: 'plan', required: ['ask', 'verify'], K: 3 },
  // investigate: no keyword signal; required ask+verify.
  { taskId: 'investigate-1', goal: 'bu durumu incele', objective: 'investigate', required: ['ask', 'verify'], K: 3 },
  { taskId: 'investigate-2', goal: 'genel durum nedir', objective: 'investigate', required: ['ask', 'verify'], K: 3 },
  { taskId: 'investigate-3', goal: 'sistemin durumu', objective: 'investigate', required: ['ask', 'verify'], K: 3 },
  // questions → verify objective.
  { taskId: 'question-1', goal: 'kedi hayvan mıdır?', objective: 'verify', required: ['verify'], K: 2 },
  { taskId: 'question-2', goal: 'bu doğru mudur?', objective: 'verify', required: ['verify'], K: 2 },
]);

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
 * Run one task on one arm. Returns the executed tool order, the run status and
 * how many steps ran (the real, observed budget consumption). The temp store is
 * closed and removed so a large corpus does not leak handles.
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
    steps: steps.length,
    status: run.data && run.data.status,
  };
}

/** A task is solved when every required tool appears in the executed order. */
function isSolved(task, order) {
  return task.required.every((tool) => order.includes(tool));
}

/** Run both arms for one task; the difference is only `opts.cognitiveScheduler`. */
function runTask(task) {
  const baseline = runArm(task, {});
  const candidate = runArm(task, { cognitiveScheduler: CANDIDATE_CONFIG });
  return {
    taskId: task.taskId,
    objective: task.objective,
    required: task.required,
    K: task.K,
    baseline,
    candidate,
    solvedBaseline: isSolved(task, baseline.order) ? 1 : 0,
    solvedCandidate: isSolved(task, candidate.order) ? 1 : 0,
  };
}

module.exports = { CANDIDATE_CONFIG, TASKS, runArm, runTask, isSolved };
