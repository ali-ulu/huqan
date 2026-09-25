const { buildFinalSummary } = require('./finalizer');
const { registerReceiverOwnedTool } = require('./lib/workflow-tool-registration');
const { createExecutionScope, evaluateGoalBinding } = require('./lib/goal-binding');
const {
  buildReport,
  deriveNextAction,
  buildRecommendations,
} = require('./lib/workflow-run-guidance');
const { selectBudgetedTools } = require('./lib/workflow-budget-selection');
const { ToolRegistry } = require('./lib/workflow-tool-registry');
const { cloneValue, normalizeName, normalizeConfidence, normalizeEvidence, normalizeError, extractText, normalizePositiveInteger } = require('./lib/workflow-values');
const { isExternalReviewApproved, createExternalReviewApproval } = require('./lib/workflow-review-approval');
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

  _selectStepTools(goal, rankedTools, objective, maxSteps, budget) {
    return selectBudgetedTools({ rankedTools, sequence: preferredSequence(objective), maxSteps, budget });
  }

  _buildPlan(goal, opts = {}) {
    const normalizedGoal = String(goal || '').trim();
    const objective = objectiveForGoal(normalizedGoal);
    const maxSteps = normalizePositiveInteger(opts.maxSteps, this.maxSteps);
    const budget = resolveBudget(opts.budget, this.budget);
    const tools = this.listTools();
    const rankedTools = this._rankTools(normalizedGoal, tools, objective);
    const selectedTools = this._selectStepTools(normalizedGoal, rankedTools, objective, maxSteps, budget);

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

    this.lastPlan = cloneValue(plan);
    return cloneValue(plan);
  }

  plan(goal, opts = {}) {
    return this._buildPlan(goal, opts);
  }

  _normalizePlanInput(goal, opts = {}) {
    if (opts.plan && typeof opts.plan === 'object' && Array.isArray(opts.plan.steps)) {
      const plan = cloneValue(opts.plan);
      plan.goal = String(plan.goal || goal || '').trim();
      plan.objective = String(plan.objective || objectiveForGoal(plan.goal));
      plan.status = plan.status || 'planned';
      plan.maxSteps = normalizePositiveInteger(plan.maxSteps, this.maxSteps);
      plan.budget = resolveBudget(plan.budget, this.budget);
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
    const steps = [];
    const evidence = [];
    const trace = Array.isArray(plan.trace) ? cloneValue(plan.trace) : [];
    const errors = [];
    const planSteps = Array.isArray(plan.steps) ? cloneValue(plan.steps) : [];
    const allTools = this.listTools();
    const selectedToolNames = Array.from(new Set(planSteps.map(step => step.tool).filter(Boolean)));
    let budgetRemaining = budget;
    let sawSuccess = false;
    let sawError = false;
    let sawBlocked = false;
    let sawReview = false;
    let paused = false;

    for (let index = 0; index < planSteps.length; index += 1) {
      if (steps.length >= maxSteps) {
        paused = true;
        break;
      }

      const plannedStep = planSteps[index];
      const goalBinding = evaluateGoalBinding(scopeResult.scope, plannedStep);
      if (!goalBinding.ok) { errors.push({ stepId: plannedStep.id, tool: plannedStep.tool, code: goalBinding.reason }); sawBlocked = true; break; }
      const registryTool = this.getTool(plannedStep.tool);
      const stepCost = normalizePositiveInteger(plannedStep.cost, registryTool ? registryTool.cost : 1);
      if (stepCost > budgetRemaining) {
        // A plan may contain an expensive step followed by an affordable one.
        // Leave the step unexecuted and keep looking; budget exhaustion is
        // reported through `paused` after every affordable candidate has had a
        // chance to run.
        paused = true;
        continue;
      }

      const context = {
        goal: plan.goal,
        objective: plan.objective,
        plan,
        step: plannedStep,
        stepIndex: index,
        maxSteps,
        budgetRemaining,
        approval: isExternalReviewApproved(opts.approval) ? opts.approval : null,
      };
      const result = await this.runTool(plannedStep.tool, plannedStep.input, context);
      budgetRemaining -= stepCost;

      const step = {
        id: plannedStep.id,
        tool: result.tool || normalizeName(plannedStep.tool),
        input: cloneValue(plannedStep.input),
        output: cloneValue(result.output),
        status: result.status,
        evidence: normalizeEvidence(result.evidence),
        confidence: normalizeConfidence(result.confidence, 0),
        error: result.error ? cloneValue(result.error) : null,
        policy: result.meta ? cloneValue(result.meta.policy) : null,
        actionFirewall: result.meta ? cloneValue(result.meta.firewall) : null,
        goalBinding: goalBinding.receipt,
        trace: [
          {
            phase: 'run',
            stepId: plannedStep.id,
            tool: result.tool || normalizeName(plannedStep.tool),
            status: result.status,
            evidenceCount: normalizeEvidence(result.evidence).length,
            confidence: normalizeConfidence(result.confidence, 0),
            policyAction: result.meta && result.meta.policy ? result.meta.policy.action : 'allow',
            riskScore: result.meta && result.meta.policy ? result.meta.policy.riskScore : 0,
            firewallDecision: result.meta && result.meta.firewall ? result.meta.firewall.decision : 'allow',
            firewallReason: result.meta && result.meta.firewall ? result.meta.firewall.reason : null,
            score: plannedStep.confidence,
          },
        ],
      };

      steps.push(step);
      trace.push(step.trace[0]);
      evidence.push(...step.evidence);

      if (step.status === 'done') {
        sawSuccess = true;
      } else if (step.status === 'blocked') {
        sawBlocked = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      } else if (step.status === 'review') {
        sawReview = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      } else {
        sawError = true;
        if (result.error) errors.push({ stepId: step.id, tool: step.tool, code: result.error.code, message: result.error.message });
        break;
      }
    }

    if (!steps.length && planSteps.length) {
      // If the first step never ran because of budget or max-step limits, report it as paused.
      paused = true;
    }

    const completedAllPlannedSteps = planSteps.length > 0 && steps.length === planSteps.length && !sawBlocked && !sawReview && !sawError && !paused;
    let status = 'blocked';
    if (completedAllPlannedSteps) {
      status = 'completed';
    } else if (paused) {
      status = 'paused';
    } else if (sawBlocked) {
      status = steps.length > 1 ? 'partial' : 'blocked';
    } else if (sawReview) {
      status = 'partial';
    } else if (sawError) {
      status = steps.some(step => step.status === 'done') ? 'partial' : 'failed';
    } else if (steps.some(step => step.status === 'done')) {
      status = 'partial';
    } else if (!planSteps.length) {
      status = 'blocked';
      errors.push({ stepId: null, tool: null, code: 'NO_STEPS', message: 'Plan does not contain any executable steps.' });
    }

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

