'use strict';

const { buildFinalSummary } = require('../finalizer');

function buildReport(run) {
  const finalSummary = run.finalSummary || buildFinalSummary(run);
  const lines = [
    `Goal: ${run.goal}`,
    `Objective: ${run.objective}`,
    `Status: ${run.status}`,
    `Steps: ${run.steps.length}`,
    `Confidence: ${run.confidence.toFixed(2)}`,
    `Next action: ${run.nextAction.action}${run.nextAction.tool ? ` -> ${run.nextAction.tool}` : ''}`,
    'Final summary:',
    `- Mode: ${finalSummary.mode}`,
    'Known facts:',
    ...(finalSummary.knownFacts.length ? finalSummary.knownFacts.map(item => `- ${item}`) : ['- none']),
    'Unknowns:',
    ...(finalSummary.unknowns.length ? finalSummary.unknowns.map(item => `- ${item}`) : ['- none']),
    `- Conclusion: ${finalSummary.conclusion}`,
    'Next questions:',
    ...(finalSummary.nextQuestions.length ? finalSummary.nextQuestions.map(item => `- ${item}`) : ['- none']),
    'Recommendations:',
    ...run.recommendations.map(item => `- ${item}`),
    'Trace:',
    ...run.trace.map(item => {
      const step = item.stepId ? `${item.stepId}: ` : '';
      const tool = item.tool ? `${item.tool}` : 'n/a';
      const status = item.status ? ` ${item.status}` : '';
      const score = Number.isFinite(item.score) ? ` score=${item.score}` : '';
      return `- ${step}${tool}${status}${score}`;
    }),
    `Final answer: ${run.finalAnswer || 'n/a'}`,
  ];
  return lines.join('\n');
}

function deriveNextAction(run, remainingSteps) {
  const nextStep = Array.isArray(remainingSteps) && remainingSteps.length ? remainingSteps[0] : null;

  if (run.status === 'completed') {
    return { action: 'none', tool: null, reason: 'Workflow completed.' };
  }
  if (run.status === 'paused') {
    return {
      action: 'resume',
      tool: nextStep ? nextStep.tool : null,
      reason: 'Step or budget limit reached.',
    };
  }
  if (run.status === 'blocked') {
    return {
      action: 'revise',
      tool: null,
      reason: 'Unknown or blocked tool must be replaced.',
    };
  }
  if (run.status === 'partial') {
    return {
      action: 'repair',
      tool: nextStep ? nextStep.tool : (run.steps[run.steps.length - 1] ? run.steps[run.steps.length - 1].tool : null),
      reason: 'A step failed; retry or simplify the plan.',
    };
  }
  if (run.status === 'failed') {
    return {
      action: 'repair',
      tool: null,
      reason: 'No step completed successfully.',
    };
  }

  return {
    action: 'continue',
    tool: nextStep ? nextStep.tool : null,
    reason: 'Continue the planned workflow.',
  };
}

function buildRecommendations(run) {
  const recommendations = [];

  if (run.status === 'completed') {
    recommendations.push('No immediate action required.');
  }
  if (run.status === 'paused') {
    recommendations.push('Resume from the remaining steps.');
    recommendations.push('Increase maxSteps or budget only if needed.');
  }
  if (run.status === 'partial') {
    recommendations.push('Inspect the failing tool and narrow the goal scope.');
    recommendations.push('Retry with a smaller plan if the failure is transient.');
  }
  if (run.status === 'failed') {
    recommendations.push('No tool completed successfully; revise the plan before retrying.');
  }
  if (run.status === 'blocked') {
    recommendations.push('Replace the unknown or blocked tool with a registered internal tool.');
  }
  if (run.evidence.length === 0) {
    recommendations.push('Add at least one tool that can produce evidence.');
  }
  if (run.confidence < 0.7) {
    recommendations.push('Collect more evidence before concluding.');
  }
  if (run.trace.some(item => item.policyAction === 'review')) {
    recommendations.push('Review policy-gated tools before re-running.');
  }

  return Array.from(new Set(recommendations));
}

module.exports = {
  buildReport,
  deriveNextAction,
  buildRecommendations,
};
