const crypto = require('crypto');
const path = require('path');
const Agent = require('./agent');
const AxiomStorage = require('./storage');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

function defaultDbPath(kernel) {
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return graphMemoryPath.replace(/\.json$/, '.db');
  }
  return path.join(process.cwd(), 'memory.db');
}

class AgentV3 {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.dream = opts.dream || (this.kernel ? new (require('./dream'))(this.kernel) : null);
    this.baseAgent = opts.baseAgent || new Agent({
      kernel: this.kernel,
      dream: this.dream,
      memoryPath: null,
      maxSteps: opts.maxSteps || 4,
    });
    this.storage = opts.storage || new AxiomStorage({
      kernel: this.kernel,
      dbPath: opts.dbPath || defaultDbPath(this.kernel),
    });
    this.maxSteps = opts.maxSteps || this.baseAgent.maxSteps || 4;
    this.maxIterations = Number.isInteger(opts.maxIterations) ? opts.maxIterations : 50;
    this.timeBudgetMs = Number.isInteger(opts.timeBudgetMs) ? opts.timeBudgetMs : 30000;
    this.lastPlan = null;
    this.lastRun = null;
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    if (this.kernel && typeof this.kernel._ok === 'function') {
      return this.kernel._ok(type, data, evidence, meta);
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

  _fail(type, code, message, evidence = [], meta = {}, data = null) {
    if (this.kernel && typeof this.kernel._fail === 'function') {
      const result = this.kernel._fail(type, code, message, meta);
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

  plan(goal, opts = {}) {
    const result = this.baseAgent.plan(goal, { ...opts, maxSteps: opts.maxSteps || this.maxSteps });
    if (!result || result.ok === false) return result;
    const memory = this.storage.getGoalMemory(goal);
    const data = cloneValue(result.data);
    data.memory = {
      ...(data.memory || {}),
      storage: {
        goal: normalizeGoal(goal),
        key: lower(goal),
        tracked: Boolean(memory),
        goalMemory: memory
          ? {
              successCount: Number(memory.success_count || 0),
              blockedCount: Number(memory.blocked_count || 0),
              errorCount: Number(memory.error_count || 0),
              resumedCount: Number(memory.resumed_count || 0),
              lastStatus: memory.last_status || 'unknown',
              pattern: memory.pattern || {},
            }
          : {
              successCount: 0,
              blockedCount: 0,
              errorCount: 0,
              resumedCount: 0,
              lastStatus: 'unknown',
              pattern: {},
            },
      },
    };
    if (data.policy && Array.isArray(data.policy.signals) && memory) {
      if (!data.policy.signals.includes('goal-memory')) {
        data.policy.signals.push('goal-memory');
      }
    }
    data.recommendations = this.baseAgent._buildRunRecommendations({
      goal: data.goal,
      objective: data.objective,
      steps: [],
      progress: { stalledCount: 0, lastSummary: '' },
      status: 'running',
    });
    this.lastPlan = data;
    return this._ok('plan', data, result.evidence || [], result.meta || {});
  }

  inspectToolPolicy(tool, input = '', context = {}) {
    return this.baseAgent.inspectToolPolicy(tool, input, context);
  }

  _hydrateState(activePlan, checkpoint = null) {
    if (checkpoint && checkpoint.state) {
      const state = cloneValue(checkpoint.state);
      state.plan = state.plan || cloneValue(activePlan);
      state.goal = state.goal || activePlan.goal;
      state.objective = state.objective || activePlan.objective;
      state.selectedTools = Array.isArray(state.selectedTools) ? state.selectedTools : [...(activePlan.selectedTools || [])];
      state.steps = Array.isArray(state.steps) ? state.steps : [];
      state.evidence = Array.isArray(state.evidence) ? state.evidence : [];
      state.notes = Array.isArray(state.notes) ? state.notes : [];
      state.queuedSteps = Array.isArray(state.queuedSteps) && state.queuedSteps.length
        ? state.queuedSteps
        : cloneValue(activePlan.steps || []);
      state.resumed = true;
      state.resumedFrom = checkpoint.id;
      state.resumeToken = checkpoint.id;
      state.checkpointId = checkpoint.id;
      state.status = 'running';
      state.progress = state.progress || { stalledCount: 0, lastSummary: '' };
      state.completedSteps = Number(state.steps.length || 0);
      state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
      state.iteration = Number(state.iteration || state.steps.length || 0);
      state.budgetRemaining = Number(checkpoint.budget_remaining || this.timeBudgetMs);
      state.startedAt = state.startedAt || nowIso();
      return state;
    }

    return {
      goal: activePlan.goal,
      objective: activePlan.objective,
      selectedTools: [...(activePlan.selectedTools || [])],
      plan: cloneValue(activePlan),
      steps: [],
      evidence: [],
      status: 'running',
      notes: [],
      queuedSteps: cloneValue(activePlan.steps || []),
      resumed: false,
      resumedFrom: null,
      resumeToken: null,
      checkpointId: null,
      startedAt: nowIso(),
      progress: { stalledCount: 0, lastSummary: '' },
      completedSteps: 0,
      remainingSteps: Array.isArray(activePlan.steps) ? activePlan.steps.length : 0,
      iteration: 0,
      budgetRemaining: this.timeBudgetMs,
    };
  }

  _saveCheckpoint(state) {
    const checkpointId = state.checkpointId || state.resumeToken || `checkpoint-${crypto.randomUUID?.() || Date.now()}`;
    state.checkpointId = checkpointId;
    state.resumeToken = checkpointId;
    state.budgetRemaining = Math.max(0, Number(state.budgetRemaining || 0));
    this.storage.saveCheckpoint({
      checkpointId,
      id: checkpointId,
      goal: state.goal,
      iteration: Number(state.iteration || 0),
      budgetRemaining: state.budgetRemaining,
      lastAction: state.lastAction || '',
      evidence: state.evidence || [],
      status: state.status || 'running',
      startedAtMs: Date.parse(state.startedAt || nowIso()) || Date.now(),
      state,
    });
    return checkpointId;
  }

  _renderReport(state) {
    const baseReport = this.baseAgent._renderReport(state);
    return [
      `Checkpoint: ${state.checkpointId || 'none'}`,
      `Resume: ${state.resumed ? 'yes' : 'no'}`,
      `Budget remaining: ${Number(state.budgetRemaining || 0)}`,
      baseReport,
    ].join('\n');
  }

  run(goal, opts = {}) {
    const planResult = this.plan(goal, opts);
    if (!planResult || planResult.ok === false) return planResult;
    const activePlan = planResult.data;
    const resumeRecord = opts.resume === false ? null : this.storage.loadLatestCheckpoint(goal);
    const state = this._hydrateState(activePlan, resumeRecord);
    const queued = Array.isArray(state.queuedSteps) ? [...state.queuedSteps] : [];
    const deadline = Date.now() + Math.max(0, Number.isInteger(opts.timeBudgetMs) ? opts.timeBudgetMs : this.timeBudgetMs);
    const maxIterations = Number.isInteger(opts.maxIterations) ? opts.maxIterations : this.maxIterations;

    this._saveCheckpoint(state);

    while (queued.length > 0 && state.steps.length < activePlan.maxSteps && state.iteration < maxIterations) {
      if (Date.now() >= deadline) {
        state.status = 'paused';
        state.pauseReason = 'time_budget_exceeded';
        break;
      }

      const step = queued.shift();
      const report = this.baseAgent._executeStepWithRetry(step, state, opts);
      state.steps.push(report);
      state.evidence.push(...this.baseAgent._collectEvidence([report.result]));
      this.baseAgent._updateToolStats(report.tool, report.status);
      state.notes.push({
        step: report.action,
        summary: report.summary,
      });
      state.iteration += 1;
      state.lastAction = report.action;

      const summary = this.baseAgent._extractAgentSummary(report.result);
      const previousSummary = state.progress?.lastSummary || '';
      const stalled = this.baseAgent._isStalledProgress(previousSummary, summary.text);
      state.progress = {
        stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0,
        lastSummary: String(summary.text || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      };

      const followUp = this.baseAgent._chooseFollowUp(step, summary, state);
      const shouldForceDream =
        state.progress.stalledCount >= 2 &&
        state.steps.length < activePlan.maxSteps &&
        !queued.some(s => s.tool === 'dream');

      if (report.status === 'blocked') {
        state.status = 'blocked';
        state.blockedBy = report.tool;
        state.blockReason = report.result?.error?.message || report.result?.error?.code || 'blocked';
        break;
      }

      if (shouldForceDream) {
        queued.unshift({
          id: `dream-${state.steps.length + 1}`,
          action: 'dream',
          tool: 'dream',
          input: {},
          rationale: 'Progress stalled; switching to hypothesis mode.',
        });
      } else if (followUp && state.steps.length < activePlan.maxSteps) {
        const nextSignature = this.baseAgent._stepSignature(followUp, state);
        if (this.baseAgent._findRecentFailure(nextSignature)) {
          const fallback = followUp.action === 'dream'
            ? null
            : { action: 'dream', tool: 'dream', input: {}, rationale: 'Previous failure repeated; safe fallback selected.' };
          if (fallback && !this.baseAgent._findRecentFailure(this.baseAgent._stepSignature(fallback, state))) {
            queued.unshift({
              id: `${fallback.action}-${state.steps.length + 1}`,
              action: fallback.action,
              tool: fallback.tool,
              input: fallback.input,
              rationale: fallback.rationale,
            });
          }
        } else {
          queued.unshift({
            id: `${followUp.action}-${state.steps.length + 1}`,
            action: followUp.action,
            tool: followUp.tool,
            input: followUp.input,
            rationale: 'Previous step produced a follow-up need.',
          });
        }
      }

      state.queuedSteps = [...queued];
      state.completedSteps = state.steps.length;
      state.remainingSteps = queued.length;
      state.budgetRemaining = Math.max(0, deadline - Date.now());
      this._saveCheckpoint(state);
    }

    if (state.status === 'running') {
      if (queued.length > 0) {
        state.status = 'paused';
        state.pauseReason = state.pauseReason || 'budget_or_iteration_limit';
      } else {
        const finalStep = state.steps[state.steps.length - 1];
        state.status = finalStep && finalStep.result && finalStep.result.ok === false ? 'blocked' : 'completed';
      }
    }

    const finalStep = state.steps[state.steps.length - 1];
    const finalSummary = finalStep ? this.baseAgent._extractAgentSummary(finalStep.result) : { text: '' };
    state.finalAnswer = finalSummary.text || 'Agent completed but no short summary could be produced.';
    state.completedSteps = state.steps.length;
    state.remainingSteps = queued.length;
    state.report = this._renderReport(state);
    state.recommendations = this.baseAgent._buildRunRecommendations(state);
    state.nextAction = this.baseAgent._suggestNextAction(state);
    state.memory = {
      path: this.storage.dbPath,
      goalMemory: this.storage.getGoalMemory(goal),
      runs: this.storage.countRuns(),
    };
    state.checkpointId = state.checkpointId || state.resumeToken || null;
    state.resumeToken = state.checkpointId;

    this.storage.saveRun(state);
    this.storage.saveGoalMemory({
      goal,
      objective: activePlan.objective,
      status: state.status,
      completedSteps: state.completedSteps,
      finalAnswer: state.finalAnswer,
      resumed: state.resumed,
      selectedTools: activePlan.selectedTools,
    });

    if (state.status === 'completed' || state.status === 'blocked') {
      this.storage.deleteCheckpoint(state.checkpointId);
    } else {
      this._saveCheckpoint(state);
    }

    this.lastRun = state;

    if (state.status === 'blocked') {
      return this._fail('agent', 'AGENT_BLOCKED', state.finalAnswer, state.evidence, {
        objective: activePlan.objective,
        selectedTools: activePlan.selectedTools,
        resumed: state.resumed,
        report: state.report,
        checkpointId: state.checkpointId,
        resumeToken: state.resumeToken,
      }, state);
    }

    return this._ok('agent', state, state.evidence, {
      objective: activePlan.objective,
      selectedTools: activePlan.selectedTools,
      resumed: state.resumed,
      checkpointId: state.checkpointId,
      resumeToken: state.resumeToken,
      paused: state.status === 'paused',
    });
  }
}

module.exports = AgentV3;
