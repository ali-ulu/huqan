const Dream = require('./dream');
const { INTERNAL_TOOLS, evaluateToolPolicy } = require('./toolPolicy');
const { mcpToolPolicy } = require('./lib/mcp-tool-policy');
const { renderRunReport } = require('./lib/agent-report-renderer');
const { normalizeSummaryText, normalizeMemoryPath } = require('./lib/agent-memory-state');
const { extractAgentSummary, buildRunRecommendations, suggestNextAction, chooseFollowUp } = require('./lib/agent-run-guidance');
const { noteMemoryFailure, resetMemoryPersistence } = require('./lib/agent-memory-persistence');
const { memoryRuntime } = require('./lib/agent-memory-runtime');
const { buildAgentPlan } = require('./lib/agent-plan-runtime');
const { executeAgentStep, executeStepWithRetry, executeAgentRun } = require('./lib/agent-step-executor');
const { emitRunLifecycle } = require('./lib/experience/runtime-seam');
const DEFAULT_MAX_STEPS = 4;
const ALLOWED_TOOLS = INTERNAL_TOOLS;
class Agent {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.plugins = this.kernel?.plugins;
    this.dream = opts.dream || (this.kernel ? new Dream(this.kernel) : null);
    this.maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
    this.memoryPath = normalizeMemoryPath(opts, this.kernel);
    this.storage = opts.storage || null;
    this.memory = this._loadMemory();
    this.lastPlan = null;
    this.lastRun = null;
    this.activeGoal = null;
  }
  _emit(event, data) {
    try { this.kernel?.observability?.recordLifecycle?.(event, data); } catch (_) {}
    // Experience Core E3 (#2378): the run's lifecycle seam. Journal presence is
    // optional and best-effort here, exactly like observability -- a run with no
    // journal stays the pre-wiring state, and a refused append never derails the
    // run loop. This is the one seam both runtimes share, because AgentV3
    // delegates its before/afterAgentRun to this method.
    const journal = this.experienceJournal || this.kernel?.experienceJournal;
    if (journal) {
      try { emitRunLifecycle(event, data, journal); } catch (_) {}
    }
    if (this.plugins && typeof this.plugins.emit === 'function') this.plugins.emit(event, data);
    return data;
  }
  ok(type, data = null, evidence = [], meta = {}) {
    if (this.kernel && typeof this.kernel.ok === 'function') {
      return this.kernel.ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }
  fail(type, code, message, evidence = [], meta = {}, data = null) {
    if (this.kernel && typeof this.kernel.fail === 'function') {
      const result = this.kernel.fail(type, code, message, meta);
      result.data = data;
      if (Array.isArray(evidence) && evidence.length) {
        result.evidence = evidence;
      }
      return result;
    }
    return {
      ok: false,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: { code, message },
      meta,
    };
  }
  _collectEvidence(items = []) {
    const evidence = [];
    for (const item of items) {
      if (item && Array.isArray(item.evidence)) evidence.push(...item.evidence);
    }
    return evidence.filter(Boolean);
  }
  _isStalledProgress(previousSummary, currentSummary) {
    const prev = normalizeSummaryText(previousSummary);
    const curr = normalizeSummaryText(currentSummary);
    if (!curr) return true;
    if (curr === 'bilmiyorum' || curr === 'unknown' || curr === 'unknown') return true;
    if (!prev) return false;
    return curr === prev;
  }
  plan(goal, opts = {}) {
    return buildAgentPlan({ goal, opts, runtime: {
      agent: this, memory: this.memory, maxSteps: this.maxSteps, goalKey: this._goalKey.bind(this), findResumeRun: this._findResumeRun.bind(this), emit: this._emit.bind(this), rememberPlan: this._rememberPlan.bind(this), ok: this.ok.bind(this),
      setLastPlan: plan => { this.lastPlan = plan; }, setActiveGoal: activeGoal => { this.activeGoal = activeGoal; },
    } });
  }

  _extractAgentSummary(result) {
    return extractAgentSummary(result);
  }

  _buildRunRecommendations(state) {
    return buildRunRecommendations(state, this.memory);
  }

  _suggestNextAction(state) {
    return suggestNextAction(state);
  }

  inspectToolPolicy(tool, input = '', context = {}) {
    // MCP tools answer from lib/mcp-tool-policy.js, where the gate adapter is
    // the authority for what calling one does; everything else falls through.
    const policy = mcpToolPolicy(String(tool || '').trim().toLowerCase())
      || evaluateToolPolicy({ tool, input, context, internalTools: ALLOWED_TOOLS });
    const approval = this._queueToolApproval(policy, input, context);
    policy.approvalId = approval ? approval.id : null;
    policy.approvalStatus = approval ? approval.status : null;
    return this.ok('policy', policy, [], {
      tool: policy.tool,
      category: policy.category,
      action: policy.action,
      approvalId: approval ? approval.id : null,
      approvalStatus: approval ? approval.status : null,
    });
  }

  _queueToolApproval(policy, input, context = {}) {
    if (!this.storage || typeof this.storage.saveToolApproval !== 'function') return null;
    if (!policy || policy.category !== 'external') return null;
    const status = policy.action === 'review' ? 'pending' : 'blocked';
    const decision = policy.action === 'review' ? '' : 'blocked';
    const reason = Array.isArray(policy.reasons) ? policy.reasons[0] || '' : '';
    try {
      return this.storage.saveToolApproval({
        tool: policy.tool,
        input,
        context,
        policy,
        status,
        decision,
        reason,
      });
    } catch (_) {
      return null;
    }
  }

  listPendingToolApprovals(limit = 20) {
    if (!this.storage || typeof this.storage.listPendingToolApprovals !== 'function') return [];
    return this.storage.listPendingToolApprovals(limit);
  }

  countPendingToolApprovals() {
    if (!this.storage || typeof this.storage.countPendingToolApprovals !== 'function') return 0;
    return this.storage.countPendingToolApprovals();
  }

  _chooseFollowUp(step, summary, state) {
    return chooseFollowUp(step, summary, state);
  }

  _isRetryableStepReport(report = {}) {
    const result = report.result || {};
    const rawError = String(result?.error?.message || result?.error?.code || result?.error || report.summary || '').toLowerCase();
    return /abort|timeout|fetch|network|econn|enotfound|etimedout|eai_again|503|502|504|429|temporarily|closed|ollama/.test(rawError);
  }

  _executeStepWithRetry(step, state, opts = {}) {
    return executeStepWithRetry({ step, state, opts, executeStep: this._executeStep.bind(this), recordFailure: this._recordFailure.bind(this), isRetryable: this._isRetryableStepReport.bind(this) });
  }

  _executeStep(step, state, opts = {}) {
    return executeAgentStep({ step, state, opts, runtime: { kernel: this.kernel, dream: this.dream, allowedTools: ALLOWED_TOOLS, emit: this._emit.bind(this) } });
  }

  run(goal, opts = {}) {
    return executeAgentRun({ goal, opts, runtime: { agent: this, fail: this.fail.bind(this), ok: this.ok.bind(this), plan: this.plan.bind(this), findResumeRun: this._findResumeRun.bind(this), emit: this._emit.bind(this), resetMemoryPersistence: () => resetMemoryPersistence(this), rememberRun: this._rememberRun.bind(this),
      executeStepWithRetry: this._executeStepWithRetry.bind(this), collectEvidence: this._collectEvidence.bind(this), updateToolStats: this._updateToolStats.bind(this), extractAgentSummary: this._extractAgentSummary.bind(this), isStalledProgress: this._isStalledProgress.bind(this), chooseFollowUp: this._chooseFollowUp.bind(this), stepSignature: this._stepSignature.bind(this), findRecentFailure: this._findRecentFailure.bind(this),
      buildRunRecommendations: this._buildRunRecommendations.bind(this), suggestNextAction: this._suggestNextAction.bind(this), renderReport: this._renderReport.bind(this), memoryInfo: () => ({ path: this.memoryPath, goals: this.memory.goals.length, runs: this.memory.runs.length }), setLastRun: state => { this.lastRun = state; } } });
  }

  stepRuntime() {
    return {
      emit: (event, data) => this._emit(event, data), executeStepWithRetry: (step, state, opts) => this._executeStepWithRetry(step, state, opts), collectEvidence: items => this._collectEvidence(items), updateToolStats: (tool, status) => this._updateToolStats(tool, status),
      extractAgentSummary: result => this._extractAgentSummary(result), isStalledProgress: (previous, current) => this._isStalledProgress(previous, current), chooseFollowUp: (step, summary, state) => this._chooseFollowUp(step, summary, state), stepSignature: (step, state) => this._stepSignature(step, state), findRecentFailure: signature => this._findRecentFailure(signature),
      buildRunRecommendations: state => this._buildRunRecommendations(state), suggestNextAction: state => this._suggestNextAction(state), renderReport: state => this._renderReport(state),
    };
  }

  _renderReport(state) {
    return renderRunReport(state, { recommendations: this._buildRunRecommendations(state), nextAction: state.nextAction || this._suggestNextAction(state) });
  }
}

Object.assign(Agent.prototype, memoryRuntime);

module.exports = Agent;
