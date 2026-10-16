'use strict';

const { buildFinalSummary } = require('../finalizer');

/**
 * Render a finished run as the operator-facing report.
 *
 * Extracted from `Agent._renderReport` so that method could shrink enough to
 * make room for `Agent.stepRuntime()` without pushing agent.js past the
 * ceiling its file-size baseline records. The recommendations and the next
 * action are passed in rather than computed here: they come from the agent's
 * own state and memory, and reaching back for them would make this module
 * depend on the class it was taken out of.
 */
function renderRunReport(state, { recommendations, nextAction }) {
  const stepLines = state.steps.map((step, index) => {
    const summary = step.summary ? ` - ${step.summary}` : '';
    return `${index + 1}. ${step.action} (${step.tool})${summary}`;
  });
  const finalSummary = state.finalSummary || buildFinalSummary(state);
  const recommendationLines = recommendations.items.map((item) => `- ${item}`);
  const nextActionLine = `${nextAction.action} -> ${nextAction.tool}: ${nextAction.reason}`;
  const toolHealthLines = recommendations.toolHealth.length
    ? recommendations.toolHealth.map(
      (item) => `- ${item.tool}: success=${item.success}, blocked=${item.blocked}, error=${item.error}`,
    )
    : ['- no usage data yet'];
  const stalled = state.progress && typeof state.progress.stalledCount === 'number'
    ? `stalled=${state.progress.stalledCount}`
    : 'unknown';
  return [
    `Goal: ${state.goal}`,
    `Objective: ${state.objective}`,
    `Status: ${state.status}`,
    `Steps completed: ${state.completedSteps}`,
    `Progress: ${stalled}`,
    `Next step: ${nextActionLine}`,
    'Judgement summary:',
    `- Mode: ${finalSummary.mode}`,
    'Known:',
    ...(finalSummary.knownFacts.length ? finalSummary.knownFacts.map((item) => `- ${item}`) : ['- none']),
    'Unknown:',
    ...(finalSummary.unknowns.length ? finalSummary.unknowns.map((item) => `- ${item}`) : ['- none']),
    `- Conclusion: ${finalSummary.conclusion}`,
    'Follow-up questions:',
    ...(finalSummary.nextQuestions.length ? finalSummary.nextQuestions.map((item) => `- ${item}`) : ['- none']),
    'Recommendation:',
    ...recommendationLines,
    'Tool health:',
    ...toolHealthLines,
    ...stepLines,
    `Result: ${state.finalAnswer}`,
  ].join('\n');
}

module.exports = { renderRunReport };
