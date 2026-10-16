const { buildFinalSummary } = require('./finalizer');
const { registerReceiverOwnedTool } = require('./lib/workflow-tool-registration');
const { createExecutionScope } = require('./lib/goal-binding');
const {
  buildReport,
  deriveNextAction,
  buildRecommendations,
} = require('./lib/workflow-run-guidance');
const { selectBudgetedTools } = require('./lib/workflow-budget-selection');
const { ToolRegistry } = require('./lib/workflow-tool-registry');
const { rankTools, buildPlan, normalizeProvidedPlan } = require('./lib/workflow-agent-plan');
const { executePlanSteps, deriveRunStatus } = require('./lib/workflow-agent-steps');
const {
  cloneValue, normalizeConfidence, normalizeEvidence, normalizeError, extractText,
  normalizePositiveInteger,
} = require('./lib/workflow-values');
const { createExternalReviewApproval } = require('./lib/workflow-review-approval');
// Tool ranking and step shaping are pure and live in their own module so this
// class stays an orchestrator (#2378). Re-exported below to keep the public
// surface unchanged.
const {
  DEFAULT_MAX_STEPS,
  DEFAULT_BUDGET,
  resolveBudget,
  objectiveForGoal,
  preferredSequence,
  scoreTool,
  buildStepInput,
} = require('./lib/workflow-planning');

class WorkflowAgent {
  constructor(opts = {}) {
    this.maxSteps = normalizePositiveInteger(opts.maxSteps, DEFAULT_MAX_STEPS);
    this.budget = resolveBudget(opts.budget, DEFAULT_BUDGET);
    this.registry = opts.registry instanceof ToolRegistry
      ? opts.registry
      : new ToolRegistry({ internalTools: opts.internalTools || [] });
    this.lastPlan = null;
    this.lastRun = null;

    if (Array.isArray(opts.tools)) {
      for (const tool of opts.tools) {
        this.registerTool(tool);
      }
    }
  }

  registerTool(tool) {
    return this.registry.registerTool(tool);
  }

  listTools() {
    return this.registry.listTools();
  }

  getTool(name) {
    return this.registry.getTool(name);
  }

  async runTool(name, input, context = {}) {
    return this.registry.runTool(name, input, context);
  }

  _rankTools(goal, tools, objective) {
    return rankTools(goal, tools, objective);
  }

  _selectStepTools(goal, rankedTools, objective, maxSteps, budget) {
    return selectBudgetedTools({ rankedTools, sequence: preferredSequence(objective), maxSteps, budget });
  }

  _buildPlan(goal, opts = {}) {
    const plan = buildPlan(goal, this.listTools(), { maxSteps: this.maxSteps, budget: this.budget }, opts);
    this.lastPlan = cloneValue(plan);
    return cloneValue(plan);
  }

  plan(goal, opts = {}) {
    return this._buildPlan(goal, opts);
  }

  _normalizePlanInput(goal, opts = {}) {
    if (opts.plan && typeof opts.plan === 'object' && Array.isArray(opts.plan.steps)) {
      return normalizeProvidedPlan(opts.plan, goal, { maxSteps: this.maxSteps, budget: this.budget });
    }

    if (Array.isArray(opts.steps)) {
      return this._normalizePlanInput(goal, {
        ...opts,
        plan: {
          goal,
          steps: opts.steps,
          selectedTools: opts.steps.map(step => step.tool).filter(Boolean),
          maxSteps: opts.maxSteps,
          budget: opts.budget,
        },
      });
    }

    return this.plan(goal, opts);
  }

  async run(goal, opts = {}) {
    const plan = this._normalizePlanInput(goal, opts);
    const scopeResult = createExecutionScope(plan.goal, { ...opts, objective: plan.objective });
    if (!scopeResult.ok) return { ok: false, status: 'blocked', errors: [{ code: scopeResult.reason }], goalBinding: scopeResult.receipt };
    const maxSteps = normalizePositiveInteger(opts.maxSteps, plan.maxSteps || this.maxSteps);
    const budget = resolveBudget(opts.budget, plan.budget ?? this.budget);
    const planSteps = Array.isArray(plan.steps) ? cloneValue(plan.steps) : [];
    const allTools = this.listTools();
    const selectedToolNames = Array.from(new Set(planSteps.map(step => step.tool).filter(Boolean)));
    const execution = await executePlanSteps(this, { plan, planSteps, scope: scopeResult.scope, opts, maxSteps, budget });
    const { steps, evidence, trace, errors, budgetRemaining } = execution;

    const status = deriveRunStatus({ planSteps, ...execution });

    const successfulSteps = steps.filter(step => step.status === 'done');
    const confidence = steps.length
      ? normalizeConfidence(steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length, 0)
      : normalizeConfidence(plan.confidence, 0);
    const finalText = [...steps].reverse().map(step => extractText(step.output)).find(Boolean) || '';
    const finalAnswer = finalText || (status === 'completed'
      ? 'Workflow completed.'
      : 'Workflow did not produce a final answer.');
    const run = {
      ok: status === 'completed',
      goal: plan.goal,
      objective: plan.objective,
      status,
      maxSteps,
      budget,
      budgetRemaining,
      selectedTools: selectedToolNames,
      steps,
      evidence,
      confidence,
      trace,
      errors,
      report: '',
      nextAction: null,
      recommendations: [],
      finalAnswer,
      plan: cloneValue(plan),
      goalBinding: scopeResult.receipt,
            tools: allTools,
    };
    run.nextAction = deriveNextAction(run, planSteps.slice(steps.length));
    run.recommendations = buildRecommendations(run);
    run.finalSummary = buildFinalSummary(run);
    run.report = buildReport(run);

    this.lastRun = cloneValue(run);
    return cloneValue(run);
  }
}

module.exports = WorkflowAgent;
module.exports.WorkflowAgent = WorkflowAgent;
module.exports.ToolRegistry = ToolRegistry;
module.exports.registerReceiverOwnedTool = registerReceiverOwnedTool;
module.exports.normalizeConfidence = normalizeConfidence;
module.exports.normalizeEvidence = normalizeEvidence;
module.exports.normalizeError = normalizeError;
module.exports.DEFAULT_BUDGET = DEFAULT_BUDGET;
module.exports.DEFAULT_MAX_STEPS = DEFAULT_MAX_STEPS;
module.exports.resolveBudget = resolveBudget;
module.exports.createExternalReviewApproval = createExternalReviewApproval;
module.exports.objectiveForGoal = objectiveForGoal;
module.exports.preferredSequence = preferredSequence;
module.exports.scoreTool = scoreTool;
module.exports.buildStepInput = buildStepInput;

