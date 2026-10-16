const { buildReport } = require('./workflow-run-guidance');
const { selectBudgetedTools } = require('./workflow-budget-selection');
const {
  cloneValue, normalizeName, normalizeConfidence, normalizePositiveInteger,
} = require('./workflow-values');
const {
  resolveBudget, objectiveForGoal, preferredSequence, scoreTool, buildStepInput,
} = require('./workflow-planning');

// WorkflowAgent's planning (workflow-agent.js): ranking the registered tools,
// building a plan from them, and normalising a caller-supplied plan. Pure: the
// agent passes in its tools and its default step/budget limits.

function rankTools(goal, tools, objective) {
  const sequence = preferredSequence(objective);
  const goalText = String(goal || '');
  const ranked = tools.map(tool => {
    const preferredIndex = sequence.indexOf(tool.name);
    const base = scoreTool(tool, goalText, objective, preferredIndex);
    return {
      tool,
      score: base.score,
      confidence: base.confidence,
      reasons: base.reasons,
      preferredIndex,
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.tool.order !== b.tool.order) return a.tool.order - b.tool.order;
    return a.tool.name.localeCompare(b.tool.name);
  });

  return ranked;
}

function buildPlan(goal, tools, defaults, opts = {}) {
  const normalizedGoal = String(goal || '').trim();
  const objective = objectiveForGoal(normalizedGoal);
  const maxSteps = normalizePositiveInteger(opts.maxSteps, defaults.maxSteps);
  const budget = resolveBudget(opts.budget, defaults.budget);
  const rankedTools = rankTools(normalizedGoal, tools, objective);
  const selectedTools = selectBudgetedTools({ rankedTools, sequence: preferredSequence(objective), maxSteps, budget });

  const steps = selectedTools.map((item, index) => ({
    id: `step-${index + 1}`,
    tool: item.tool.name,
    input: buildStepInput(normalizedGoal, objective, item.tool.name, index, selectedTools.length),
    status: 'planned',
    evidence: [],
    confidence: item.confidence,
    cost: item.tool.cost,
    reason: item.reasons.join(', '),
  }));

  const trace = rankedTools.map(item => ({
    phase: 'plan',
    tool: item.tool.name,
    score: item.score,
    confidence: item.confidence,
    reasons: item.reasons,
  }));

  const confidence = steps.length
    ? normalizeConfidence(steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length, 0.5)
    : 0;

  const plan = {
    ok: true,
    goal: normalizedGoal,
    objective,
    status: 'planned',
    maxSteps,
    budget,
    selectedTools: steps.map(step => step.tool),
    steps,
    evidence: [],
    confidence,
    trace,
    errors: [],
    report: buildReport({
      goal: normalizedGoal,
      objective,
      status: 'planned',
      steps,
      confidence,
      nextAction: { action: 'run', tool: steps[0] ? steps[0].tool : null, reason: 'Plan ready.' },
      recommendations: ['Run the selected tools in order.'],
      trace,
      finalAnswer: '',
    }),
    nextAction: {
      action: 'run',
      tool: steps[0] ? steps[0].tool : null,
      reason: 'Plan ready.',
    },
    recommendations: ['Run the selected tools in order.'],
    finalAnswer: '',
    toolScores: rankedTools.map(item => ({
      tool: item.tool.name,
      score: item.score,
      confidence: item.confidence,
      reasons: item.reasons,
    })),
  };

  return plan;
}

function normalizeProvidedPlan(provided, goal, defaults) {
  const plan = cloneValue(provided);
  plan.goal = String(plan.goal || goal || '').trim();
  plan.objective = String(plan.objective || objectiveForGoal(plan.goal));
  plan.status = plan.status || 'planned';
  plan.maxSteps = normalizePositiveInteger(plan.maxSteps, defaults.maxSteps);
  plan.budget = resolveBudget(plan.budget, defaults.budget);
  plan.selectedTools = Array.isArray(plan.selectedTools) ? [...plan.selectedTools] : plan.steps.map(step => step.tool).filter(Boolean);
  plan.steps = plan.steps.map((step, index) => ({
    id: String(step.id || `step-${index + 1}`),
    tool: normalizeName(step.tool),
    input: step.input !== undefined ? cloneValue(step.input) : buildStepInput(plan.goal, plan.objective, step.tool, index, plan.steps.length),
    status: step.status || 'planned',
    evidence: Array.isArray(step.evidence) ? cloneValue(step.evidence) : [],
    confidence: normalizeConfidence(step.confidence, 0.5),
    cost: normalizePositiveInteger(step.cost, 1),
    reason: String(step.reason || ''),
  }));
  plan.trace = Array.isArray(plan.trace) ? cloneValue(plan.trace) : [];
  plan.errors = Array.isArray(plan.errors) ? cloneValue(plan.errors) : [];
  plan.evidence = Array.isArray(plan.evidence) ? cloneValue(plan.evidence) : [];
  plan.report = String(plan.report || '');
  plan.nextAction = plan.nextAction && typeof plan.nextAction === 'object' ? cloneValue(plan.nextAction) : null;
  plan.recommendations = Array.isArray(plan.recommendations) ? [...plan.recommendations] : [];
  plan.finalAnswer = String(plan.finalAnswer || '');
  return plan;
}

module.exports = { rankTools, buildPlan, normalizeProvidedPlan };
