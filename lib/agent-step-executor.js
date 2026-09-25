'use strict';

const { evaluateToolPolicy } = require('../toolPolicy');
const { emitGateTelemetry } = require('./gate-telemetry');
const { enforceAgentActionStep } = require('./agent-action-step-enforcement');
const { evaluateGoalBinding } = require('./goal-binding');
const { behavioralBlockResult } = require('./agent-behavioral-integrity');
const { firstWords, stripQuestionMarks } = require('./agent-memory-state');
const { extractAgentSummary } = require('./agent-run-guidance');
const { createExecutionScope } = require('./goal-binding');
const { initializeBehavioralState } = require('./agent-behavioral-integrity');
const { cloneValue, nowIso, normalizeSummaryText } = require('./agent-memory-state');
const { buildFinalSummary } = require('../finalizer');
const { runEnvelopeMeta } = require('./agent-memory-persistence');
const { emergencyStopLedger } = require('./emergency-stop');
const { proposeStopForBlockedStep } = require('./behavioral-stop-bridge');

function unsupportedToolResult(step, allowedTools) {
  return { ok: false, type: 'agent', data: null, evidence: [], error: { code: 'UNSUPPORTED_TOOL', message: `Unsupported tool: ${String(step.tool || 'unknown')}` }, meta: { blocked: true, allowedTools: [...allowedTools] } };
}

const INTERNAL_TOOL_HANDLERS = Object.freeze({
  learn: (runtime, step, _state, opts) => runtime.kernel.learn(step.input, opts.learnOpts || {}),
  ask: (runtime, step, _state, opts) => runtime.kernel.ask(step.input, opts.askOpts || {}),
  verify: (runtime, step, _state, opts) => runtime.kernel.verify(step.input, opts.verifyOpts || {}),
  reason: (runtime, step, state, opts) => runtime.kernel.reason(stripQuestionMarks(step.input || state.goal), opts.reasonOpts || {}),
  compare: (runtime, step, state, opts) => {
    const text = String(step.input || state.goal);
    const parts = text.split('|').map(value => value.trim()).filter(Boolean);
    return parts.length >= 2
      ? runtime.kernel.compare(parts[0], parts[1], opts.compareOpts || {})
      : runtime.kernel.compare(firstWords(text, 2), firstWords(text.split(/\s+/).slice(2).join(' '), 2), opts.compareOpts || {});
  },
  dream: (runtime, _step, _state, opts) => runtime.dream ? runtime.dream.dream(opts.dreamOpts || {}) : runtime.kernel.dream(opts.dreamOpts || {}),
});

function executeInternalTool(runtime, step, state, opts) {
  const handler = Object.hasOwn(INTERNAL_TOOL_HANDLERS, step.tool) ? INTERNAL_TOOL_HANDLERS[step.tool] : null;
  return handler ? handler(runtime, step, state, opts) : unsupportedToolResult(step, runtime.allowedTools);
}

function executeAgentStep({ step, state, opts = {}, runtime }) {
  const { kernel, allowedTools, emit } = runtime;
  // #2505 F: a stopped agent or workspace runs no further step. The blocked
  // report ends the run the way any blocked step does.
  const stop = emergencyStopLedger(opts).check({ workspaceId: state.workspaceId, agentId: state.agentId });
  if (stop.stopped) {
    return { id: step.id, action: step.action, tool: step.tool, input: step.input, rationale: step.rationale, status: 'blocked', summary: '', result: { ok: false, type: 'agent', data: null, evidence: [], error: { code: 'AGENT_EMERGENCY_STOPPED', message: 'This agent is under an emergency stop.' }, meta: { blocked: true, emergencyStop: { scope: stop.scope, reason: stop.reason } } }, policy: null, actionFirewall: null, goalBinding: null };
  }
  const goalBinding = state.executionScope ? evaluateGoalBinding(state.executionScope, step) : { ok: true, receipt: null };
  if (!goalBinding.ok) {
    return { id: step.id, action: step.action, tool: step.tool, input: step.input, rationale: step.rationale, status: 'blocked', summary: '', result: { ok: false, type: 'agent', data: null, evidence: [], error: { code: goalBinding.reason, message: 'Step attempted to change the trusted execution scope.' }, meta: { blocked: true, goalBinding: goalBinding.receipt } }, policy: null, actionFirewall: null, goalBinding: goalBinding.receipt };
  }
  const beforeTaskData = emit('beforeTask', { step, state, opts });
  const firewallResult = enforceAgentActionStep({ step, state, opts, kernel, allowedTools });
  const firewallDecision = firewallResult.firewallDecision;
  let toolPolicy = null;
  let result = behavioralBlockResult(state, step, { firewallDecision });
  if (result) {
    // #2505 F-3: a quarantine, block or pause recommendation opens a stop
    // proposal through operator approval. Dormant without an approval
    // runtime: proposeStopForBlockedStep returns null and the report below
    // is byte-identical to before.
    const stopProposal = proposeStopForBlockedStep({ result, state, runtime });
    if (stopProposal) result.meta.behavioralStopProposal = stopProposal;
  }
  if (!result && beforeTaskData?.blocked === true) {
    result = { ok: false, type: 'agent', data: null, evidence: [], error: { code: 'BEFORE_TASK_BLOCKED', message: beforeTaskData.blockReason || 'A beforeTask plugin blocked this step.' }, meta: { blocked: true, blockedBy: beforeTaskData.blockedBy || null } };
  } else if (!result && firewallResult.result) {
    result = firewallResult.result;
  } else if (!result) {
    toolPolicy = evaluateToolPolicy({ tool: step.tool, input: step.input, context: { goal: state.goal, objective: state.objective, action: step.action }, internalTools: allowedTools });
    if (toolPolicy.category !== 'internal') {
      emitGateTelemetry(kernel, 'agent-tool-policy', { decision: toolPolicy.action, reason: toolPolicy.reasons[0] || '', metadata: { tool: toolPolicy.tool, category: toolPolicy.category, riskScore: toolPolicy.riskScore, blocked: toolPolicy.blocked, review: toolPolicy.review } });
      const code = toolPolicy.blocked ? 'EXTERNAL_TOOL_BLOCKED' : 'EXTERNAL_TOOL_REVIEW_REQUIRED';
      result = { ok: false, type: 'agent', data: null, evidence: [], error: { code, message: toolPolicy.reasons[0] || `External tool ${toolPolicy.action} required.` }, meta: { blocked: true, allowedTools: [...allowedTools], policy: toolPolicy } };
    } else {
      result = executeInternalTool(runtime, step, state, opts);
    }
  }
  const summary = extractAgentSummary(result);
  const blocked = result?.error?.code === 'UNSUPPORTED_TOOL' || result?.meta?.blocked === true;
  const stepReport = { id: step.id, action: step.action, tool: step.tool, input: step.input, rationale: step.rationale, status: blocked ? 'blocked' : (result?.ok === false ? 'error' : 'done'), summary: summary.text || '', result, policy: toolPolicy, actionFirewall: firewallDecision, goalBinding: goalBinding.receipt };
  // `attempt` rides beside the report rather than inside it: the step report is
  // part of the byte-frozen run envelope (pinned by
  // `agent-memory-planning-split.test.js`), while the emit payload is the
  // plugin hook's own shape. The Experience seam needs the attempt to give a
  // retry its own identity; the envelope must not grow a field for it.
  emit('afterTask', { step: stepReport, state, opts, attempt: step.attempt });
  return stepReport;
}

function executeStepWithRetry({ step, state, opts = {}, executeStep, recordFailure, isRetryable }) {
  const maxRetries = Number.isInteger(opts.stepRetries) ? Math.max(0, opts.stepRetries) : 2;
  let lastReport = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const report = executeStep({ ...step, attempt: attempt + 1 }, state, opts);
    lastReport = report;
    if (report.status !== 'error') return report;
    recordFailure(step, state, report.result, attempt + 1);
    if (!isRetryable(report) || attempt >= maxRetries) break;
  }
  return lastReport;
}

function createRunState(freshPlan, resumeCandidate) {
  const activePlan = resumeCandidate?.plan || freshPlan;
  return resumeCandidate ? {
    goal: activePlan.goal, objective: activePlan.objective, selectedTools: [...(activePlan.selectedTools || [])], plan: cloneValue(activePlan),
    steps: Array.isArray(resumeCandidate.steps) ? cloneValue(resumeCandidate.steps) : [], evidence: Array.isArray(resumeCandidate.evidence) ? cloneValue(resumeCandidate.evidence) : [],
    status: 'running', notes: Array.isArray(resumeCandidate.notes) ? cloneValue(resumeCandidate.notes) : [],
    queuedSteps: Array.isArray(resumeCandidate.queuedSteps) && resumeCandidate.queuedSteps.length ? cloneValue(resumeCandidate.queuedSteps) : cloneValue(activePlan.steps || []),
    resumed: true, resumedFrom: resumeCandidate.id, startedAt: resumeCandidate.startedAt || nowIso(), progress: resumeCandidate.progress ? cloneValue(resumeCandidate.progress) : { stalledCount: 0, lastSummary: '' },
  } : {
    goal: freshPlan.goal, objective: freshPlan.objective, selectedTools: [...freshPlan.selectedTools], plan: cloneValue(freshPlan), steps: [], evidence: [], status: 'running', notes: [],
    queuedSteps: cloneValue(freshPlan.steps || []), resumed: false, resumedFrom: null, startedAt: nowIso(), progress: { stalledCount: 0, lastSummary: '' },
  };
}

function executeAgentRun({ goal, opts = {}, runtime }) {
  const scopeResult = createExecutionScope(goal, opts);
  if (!scopeResult.ok) return runtime.fail('agent', scopeResult.reason, 'Untrusted content cannot define an execution goal.', [], { goalBinding: scopeResult.receipt });
  const planResult = runtime.plan(goal, opts);
  if (!planResult || planResult.ok === false) return planResult;
  const freshPlan = planResult.data;
  const resumeCandidate = opts.resume === false ? null : runtime.findResumeRun(goal);
  const activePlan = resumeCandidate?.plan || freshPlan;
  const state = createRunState(freshPlan, resumeCandidate);
  state.completedSteps = state.steps.length;
  state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
  state.workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim() ? opts.workspaceId.trim() : (resumeCandidate?.workspaceId || state.workspaceId || 'default');
  state.agentId = String(opts.agentId || resumeCandidate?.agentId || state.agentId || 'agent-v1');
  state.executionScope = scopeResult.scope;
  state.behavioralManifest = resumeCandidate?.behavioralManifest;
  state.behavioralFindings = resumeCandidate?.behavioralFindings ? cloneValue(resumeCandidate.behavioralFindings) : [];
  initializeBehavioralState(state, { ...state, agentId: state.agentId, selectedTools: [...(state.selectedTools || []), 'dream'], capabilities: (activePlan.steps || []).map(step => step.action) });
  runtime.emit('beforeAgentRun', state);
  runtime.resetMemoryPersistence();
  const queued = Array.isArray(state.queuedSteps) ? [...state.queuedSteps] : [];
  runtime.rememberRun(state);
  while (queued.length > 0 && state.steps.length < activePlan.maxSteps) {
    const step = queued.shift();
    const report = runtime.executeStepWithRetry(step, state, opts);
    state.steps.push(report);
    state.evidence.push(...runtime.collectEvidence([report.result]));
    runtime.updateToolStats(report.tool, report.status);
    state.notes.push({ step: report.action, summary: report.summary });
    const summary = runtime.extractAgentSummary(report.result);
    const stalled = runtime.isStalledProgress(state.progress?.lastSummary || '', summary.text);
    state.progress = { stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0, lastSummary: normalizeSummaryText(summary.text) };
    const followUp = runtime.chooseFollowUp(step, summary, state);
    const shouldForceDream = state.progress.stalledCount >= 2 && state.steps.length < activePlan.maxSteps && !queued.some(candidate => candidate.tool === 'dream');
    if (shouldForceDream) {
      queued.unshift({ id: `dream-${state.steps.length + 1}`, action: 'dream', tool: 'dream', input: {}, rationale: 'Progress stalled; switching to hypothesis mode.' });
    } else if (followUp && state.steps.length < activePlan.maxSteps) {
      const nextSignature = runtime.stepSignature(followUp, state);
      if (runtime.findRecentFailure(nextSignature)) {
        const fallback = followUp.action === 'dream' ? null : { action: 'dream', tool: 'dream', input: {}, rationale: 'The same error repeated, so a safe fallback was chosen.' };
        if (fallback && !runtime.findRecentFailure(runtime.stepSignature(fallback, state))) queued.unshift({ id: `${fallback.action}-${state.steps.length + 1}`, ...fallback });
      } else {
        queued.unshift({ id: `${followUp.action}-${state.steps.length + 1}`, action: followUp.action, tool: followUp.tool, input: followUp.input, rationale: 'The result of the previous step required an additional step.' });
      }
    }
    state.queuedSteps = [...queued];
    state.completedSteps = state.steps.length;
    state.remainingSteps = queued.length;
    runtime.rememberRun(state);
  }
  const finalStep = state.steps[state.steps.length - 1];
  const finalSummary = finalStep ? runtime.extractAgentSummary(finalStep.result) : { text: '' };
  const finalAnswer = finalSummary.text || 'The agent completed the task but could not produce a short summary.';
  state.status = finalStep?.result?.ok === false ? 'blocked' : (queued.length > 0 ? 'paused' : 'completed');
  state.finalSummary = buildFinalSummary({ goal: state.goal, objective: activePlan.objective, status: state.status, steps: state.steps, evidence: state.evidence, finalAnswer, selectedTools: activePlan.selectedTools });
  state.finalAnswer = state.finalSummary.conclusion || finalAnswer;
  state.completedSteps = state.steps.length;
  state.remainingSteps = queued.length;
  state.recommendations = runtime.buildRunRecommendations(state);
  state.nextAction = runtime.suggestNextAction(state);
  state.report = runtime.renderReport(state);
  state.memory = runtime.memoryInfo();
  runtime.setLastRun(state);
  runtime.rememberRun(state);
  runtime.emit('afterAgentRun', state);
  if (state.status === 'blocked') return runtime.fail('agent', 'AGENT_BLOCKED', finalAnswer, state.evidence, { objective: activePlan.objective, selectedTools: activePlan.selectedTools, resumed: state.resumed, report: state.report, ...runEnvelopeMeta(runtime.agent, state.steps) }, state);
  return runtime.ok('agent', state, state.evidence, { objective: activePlan.objective, selectedTools: activePlan.selectedTools, resumed: state.resumed, ...runEnvelopeMeta(runtime.agent, state.steps) });
}

module.exports = { executeAgentStep, executeStepWithRetry, executeAgentRun };
