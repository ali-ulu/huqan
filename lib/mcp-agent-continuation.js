'use strict';

function fail(code, message, meta = {}) {
  return {
    ok: false,
    type: 'agent',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function continuationData(result, request, checkpoint) {
  const state = result?.data && typeof result.data === 'object' ? result.data : {};
  const plan = state.plan && typeof state.plan === 'object' ? state.plan : {};
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const continuationDecision = request.mode === 'repair'
    ? {
      mode: 'repair',
      decision: 'requested',
      reason: request.repairReason,
      source: 'operator',
      workspaceId: request.workspaceId,
      checkpointId: checkpoint.id,
    }
    : null;
  const approvalReferences = steps.flatMap((step) => {
    const approvalId = step?.result?.data?.approval?.approvalId
      || step?.result?.data?.approvalId
      || step?.result?.approvalId;
    return approvalId ? [{ approvalId: String(approvalId), stepId: step.id || null }] : [];
  });
  return {
    ...state,
    runId: state.runId || state.memoryId || state.checkpointId || checkpoint.id,
    planId: state.planId || plan.planId || plan.id || null,
    planVersion: state.planVersion || plan.planVersion || plan.version || null,
    checkpointId: state.checkpointId || checkpoint.id,
    resumeToken: state.resumeToken || checkpoint.id,
    workspaceId: request.workspaceId,
    status: state.status || 'unknown',
    pauseReason: state.pauseReason || null,
    nextAction: state.nextAction || null,
    stepTrace: steps,
    approvalReferences,
    receiptId: state.receiptId || null,
    continuationMode: request.mode,
    repairReason: request.mode === 'repair' ? request.repairReason : null,
    continuationDecision,
    // A repair request is not an approval or an execution verdict. Keep this
    // field null until a real repair policy produces a decision.
    repairDecision: null,
  };
}

function executeMcpAgentContinuation(agent, args = {}) {
  const goal = normalizeString(args.goal);
  const workspaceId = normalizeString(args.workspaceId);
  const checkpointId = normalizeString(args.checkpointId);
  const resumeToken = normalizeString(args.resumeToken);
  const mode = normalizeString(args.mode || 'resume');
  const repairReason = normalizeString(args.repairReason);

  if (!goal || !workspaceId || !checkpointId || !resumeToken) {
    return fail('AGENT_CONTINUATION_FIELDS_REQUIRED', 'goal, workspaceId, checkpointId and resumeToken are required.');
  }
  if (!['resume', 'repair'].includes(mode)) {
    return fail('AGENT_CONTINUATION_MODE_INVALID', 'mode must be "resume" or "repair".');
  }
  if (mode === 'repair' && !repairReason) {
    return fail('AGENT_REPAIR_REASON_REQUIRED', 'repairReason is required for repair mode.');
  }
  if (!agent || !agent.storage || typeof agent.storage.loadLatestCheckpoint !== 'function') {
    return fail('AGENT_CHECKPOINT_STORAGE_UNAVAILABLE', 'Agent checkpoint storage is unavailable.');
  }

  // Named selection beats recency: the caller asked for a specific
  // checkpoint, so look that one up directly (still scoped to goal and
  // workspace). The latest non-completed checkpoint remains the default
  // fallback only when the named row cannot be found, and the id check
  // below is what keeps an unfindable name a refusal rather than a
  // silent substitution. (#880)
  let checkpoint;
  let lookupOperation = 'loadCheckpoint';
  try {
    checkpoint = agent.storage.loadCheckpoint
      ? agent.storage.loadCheckpoint(checkpointId, goal, workspaceId)
      : null;
    if (!checkpoint) {
      checkpoint = agent.storage.loadLatestCheckpoint(goal, workspaceId);
      lookupOperation = 'loadLatestCheckpoint';
    }
  } catch (error) {
    return fail('AGENT_CHECKPOINT_LOOKUP_FAILED', 'Agent checkpoint lookup failed.', {
      operation: lookupOperation,
      error: error?.code || error?.name || 'error',
    });
  }
  if (!checkpoint || checkpoint.id !== checkpointId) {
    return fail('AGENT_CHECKPOINT_NOT_FOUND', 'No matching checkpoint exists for this goal and workspace.', {
      retrySafe: false,
      workspaceId,
    });
  }
  if (checkpoint.state?.resumeToken !== undefined && checkpoint.state.resumeToken !== resumeToken) {
    return fail('AGENT_RESUME_TOKEN_INVALID', 'The supplied resume token does not match the checkpoint.', {
      retrySafe: false,
      checkpointId,
      workspaceId,
    });
  }
  if (checkpoint.id !== resumeToken) {
    return fail('AGENT_RESUME_TOKEN_INVALID', 'The supplied resume token does not match the checkpoint.', {
      retrySafe: false,
      checkpointId,
      workspaceId,
    });
  }
  if (checkpoint.state?.status && !['paused', 'running'].includes(checkpoint.state.status)) {
    return fail('AGENT_CHECKPOINT_NOT_RESUMABLE', 'The checkpoint is not in a resumable state.', {
      status: checkpoint.state.status,
      checkpointId,
      workspaceId,
    });
  }

  let result;
  try {
    result = agent.run(goal, {
      workspaceId,
      resume: true,
      checkpointId,
      resumeToken,
      mode,
      ...(mode === 'repair' ? { repairReason } : {}),
      ...(Number.isInteger(args.maxSteps) ? { maxSteps: args.maxSteps } : {}),
    });
  } catch (error) {
    return fail('AGENT_CONTINUATION_FAILED', 'Agent continuation failed.', {
      error: error?.code || error?.name || 'error',
      checkpointId,
      workspaceId,
    });
  }
  if (result && typeof result.then === 'function') {
    return result.then((resolved) => ({
      ...resolved,
      data: continuationData(resolved, { workspaceId, mode, repairReason }, checkpoint),
    }));
  }
  return {
    ...result,
    data: continuationData(result, { workspaceId, mode, repairReason }, checkpoint),
  };
}

module.exports = { executeMcpAgentContinuation };

