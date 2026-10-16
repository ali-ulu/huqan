const { evaluateGoalBinding } = require('./goal-binding');
const { isExternalReviewApproved } = require('./workflow-review-approval');
const {
  cloneValue, normalizeName, normalizeConfidence, normalizeEvidence, normalizePositiveInteger,
} = require('./workflow-values');

// WorkflowAgent#run's step loop (workflow-agent.js): runs the planned steps in
// order within the step and budget limits, and derives the run status.

async function executePlanSteps(agent, { plan, planSteps, scope, opts, maxSteps, budget }) {
  const steps = [];
  const evidence = [];
  const trace = Array.isArray(plan.trace) ? cloneValue(plan.trace) : [];
  const errors = [];
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
    const goalBinding = evaluateGoalBinding(scope, plannedStep);
    if (!goalBinding.ok) { errors.push({ stepId: plannedStep.id, tool: plannedStep.tool, code: goalBinding.reason }); sawBlocked = true; break; }
    const registryTool = agent.getTool(plannedStep.tool);
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
    const result = await agent.runTool(plannedStep.tool, plannedStep.input, context);
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

  return { steps, evidence, trace, errors, budgetRemaining, sawSuccess, sawError, sawBlocked, sawReview, paused };
}

function deriveRunStatus({ planSteps, steps, errors, sawBlocked, sawReview, sawError, paused }) {
  const completedAllPlannedSteps = planSteps.length > 0 && steps.length === planSteps.length && !sawBlocked && !sawReview && !sawError && !paused;
  // Precedence order: the first condition that holds names the run.
  if (completedAllPlannedSteps) return 'completed';
  if (paused) return 'paused';
  if (sawBlocked) return steps.length > 1 ? 'partial' : 'blocked';
  if (sawReview) return 'partial';
  if (sawError) return steps.some(step => step.status === 'done') ? 'partial' : 'failed';
  if (steps.some(step => step.status === 'done')) return 'partial';
  if (!planSteps.length) {
    errors.push({ stepId: null, tool: null, code: 'NO_STEPS', message: 'Plan does not contain any executable steps.' });
  }
  return 'blocked';
}

module.exports = { executePlanSteps, deriveRunStatus };
