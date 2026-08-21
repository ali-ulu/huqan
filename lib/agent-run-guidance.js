'use strict';

function extractAgentSummary(result) {
  if (!result || typeof result !== 'object') return { text: '', status: 'unknown', evidence: [] };
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  return {
    text:
      data.answer ||
      data.explanation ||
      data.summary ||
      data.reason ||
      data.hypothesis ||
      data.status ||
      '',
    status: data.status || 'unknown',
    evidence,
    data,
  };
}

function buildRunRecommendations(state, memory = {}) {
  const recommendations = new Set();
  const lastStep = state.steps[state.steps.length - 1] || null;
  const blocked = state.status === 'blocked' || lastStep?.status === 'blocked';
  const stalledCount = Number(state.progress?.stalledCount || 0);
  const policySignals = Array.isArray(state.plan?.policy?.signals) ? state.plan.policy.signals : [];

  if (blocked) recommendations.add('Continue with the permitted tool set only, and narrow the request.');
  if (state.status === 'paused') recommendations.add('Resume from the checkpoint before changing the goal.');
  if (stalledCount >= 2) recommendations.add('Restate the goal or add context before repeating the same tool.');
  if (policySignals.includes('recent-failure')) recommendations.add('Do not repeat a tool signature that failed recently; fall back to ask or dream.');
  if (policySignals.includes('tool-health-risk')) recommendations.add('Narrow the goal before retrying a weak tool path.');
  if (state.objective === 'verify') recommendations.add('Gather context with ask first, then audit the focused statement with verify.');
  if (state.objective === 'reason') recommendations.add('Strengthen the cause and evidence chain with intermediate facts.');
  if (!recommendations.size) recommendations.add('Continue with the selected tool mix.');

  const toolHealth = Object.entries(memory?.stats?.tools || {})
    .map(([tool, stat]) => ({
      tool,
      success: Number(stat.success || 0),
      blocked: Number(stat.blocked || 0),
      error: Number(stat.error || 0),
    }))
    .filter(item => item.success || item.blocked || item.error)
    .sort((a, b) => (b.error + b.blocked) - (a.error + a.blocked))
    .slice(0, 3);

  return {
    items: [...recommendations],
    toolHealth,
  };
}

function suggestNextAction(state) {
  const lastStep = state.steps[state.steps.length - 1] || null;
  const blocked = state.status === 'blocked' || lastStep?.status === 'blocked';
  const stalledCount = Number(state.progress?.stalledCount || 0);
  const selectedTools = Array.isArray(state.selectedTools) ? state.selectedTools : [];
  const completedActions = new Set((state.steps || []).map(step => step.action));
  const lastPolicy = lastStep?.policy || null;

  if (blocked) {
    return {
      action: 'revise',
      tool: 'ask',
      reason: 'Blocked execution detected; refine the request and use only allowed tools.',
    };
  }
  if (stalledCount >= 2) {
    return {
      action: 'reframe',
      tool: 'dream',
      reason: 'Progress stalled; reframe the target or add new context.',
    };
  }
  if (state.status === 'paused') {
    return {
      action: 'resume',
      tool: selectedTools[0] || 'ask',
      reason: 'Run paused before completion; continue from the checkpoint.',
    };
  }
  if (lastPolicy && lastPolicy.category === 'external' && lastPolicy.action === 'review') {
    return {
      action: 'approval',
      tool: lastStep.tool,
      reason: 'External tool request is waiting for approval before execution.',
    };
  }
  if (lastStep && lastStep.result && lastStep.result.ok === false) {
    return {
      action: 'fallback',
      tool: selectedTools.includes('dream') ? 'dream' : 'ask',
      reason: 'Last step failed; switch to the safest available fallback.',
    };
  }
  if (state.objective === 'verify') {
    if (!completedActions.has('verify')) {
      return {
        action: 'verify',
        tool: 'verify',
        reason: 'Verification has not run yet for this objective.',
      };
    }
    return {
      action: 'explain',
      tool: selectedTools.includes('reason') ? 'reason' : 'ask',
      reason: 'Verification ran; explain the result or gather missing context.',
    };
  }
  if (state.objective === 'reason') {
    return {
      action: 'reason',
      tool: 'reason',
      reason: 'Reasoning objective should continue with a cause/evidence chain.',
    };
  }
  return {
    action: 'continue',
    tool: selectedTools[0] || 'ask',
    reason: 'Current flow is healthy; continue with the selected tool mix.',
  };
}

function chooseFollowUp(step, summary, state) {
  if (step.action === 'verify') {
    if (summary.status === 'unknown') return { action: 'dream', tool: 'dream', input: {} };
    return null;
  }
  if (step.action === 'ask') {
    if (!summary.text || summary.text === 'Bilmiyorum') return { action: 'dream', tool: 'dream', input: {} };
    if (state.objective === 'verify') return { action: 'verify', tool: 'verify', input: state.goal };
    if (state.objective === 'reason') return { action: 'reason', tool: 'reason', input: state.goal };
  }
  if (step.action === 'compare' && (!summary.text || summary.text === 'Bilmiyorum')) {
    return { action: 'dream', tool: 'dream', input: {} };
  }
  if (step.action === 'dream') {
    return null;
  }
  if (step.action === 'learn') {
    return { action: 'verify', tool: 'verify', input: state.goal };
  }
  return null;
}

module.exports = {
  extractAgentSummary,
  buildRunRecommendations,
  suggestNextAction,
  chooseFollowUp,
};
