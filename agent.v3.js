const crypto = require('crypto');
const { createExecutionScope } = require('./lib/goal-binding');
const path = require('path');
const Agent = require('./agent');
const HuqanStorage = require('./storage');
const { evaluateAgentLoopBudget, DEFAULT_MAX_ITERATIONS_PER_WINDOW, DEFAULT_WINDOW_MS } = require('./lib/agent-loop-budget-gate');
const { emitGateTelemetry } = require('./lib/gate-telemetry');
const { initializeBehavioralState } = require('./lib/agent-behavioral-integrity');
const {
  loopEnabled,
  isDreamExperimentVerificationStep,
  prepareDreamExperiment,
  prepareDreamQueue,
  processDreamStep,
  selectDreamNextAction,
} = require('./lib/agent-v3-dream-loop-adapter');

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

/**
 * #329: the baseAgent below is built without storage on purpose -- plan() and
 * the step executors share that instance, so a full storage object would
 * switch on agent.js's own saveRun()/saveGoalMemory() paths underneath v3,
 * which owns that persistence itself. But Agent.inspectToolPolicy() queues its
 * approval record through this.storage.saveToolApproval(), so a storage-less
 * baseAgent made the v3 approval gate record nothing at all.
 *
 * This is the narrowest seam that closes it: one capability, forwarded lazily
 * to v3's storage (which is constructed after baseAgent). Every other v1
 * persistence path stays disabled by its own
 * `typeof this.storage.X === 'function'` guard, because those methods are
 * simply absent here.
 */
function createToolApprovalSeam(getStorage) {
  return {
    saveToolApproval(record) {
      const storage = getStorage();
      if (!storage || typeof storage.saveToolApproval !== 'function') return null;
      return storage.saveToolApproval(record);
    },
  };
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
      storage: createToolApprovalSeam(() => this.storage),
    });
    this.storage = opts.storage || new HuqanStorage({
      kernel: this.kernel,
      dbPath: opts.dbPath || defaultDbPath(this.kernel),
    });
    this.maxSteps = opts.maxSteps || this.baseAgent.maxSteps || 4;
    this.maxIterations = Number.isInteger(opts.maxIterations) ? opts.maxIterations : 50;
    this.timeBudgetMs = Number.isInteger(opts.timeBudgetMs) ? opts.timeBudgetMs : 30000;
    this.dreamExperimentLoop = opts.dreamExperimentLoop !== false;
    // AB10: durable per-workspace ceiling, separate from the single-call
    // maxIterations/timeBudgetMs above.
    this.maxIterationsPerWindow = Number.isInteger(opts.maxIterationsPerWindow) ? opts.maxIterationsPerWindow : DEFAULT_MAX_ITERATIONS_PER_WINDOW;
    this.agentLoopBudgetWindowMs = Number.isInteger(opts.agentLoopBudgetWindowMs) ? opts.agentLoopBudgetWindowMs : DEFAULT_WINDOW_MS;
    this.lastPlan = null;
    this.lastRun = null;
  }

  /**
   * AB10: looks up durable per-workspace usage and evaluates it against the
   * budget gate.
   *
   * Fail-closed on an unreadable counter. A storage that does not implement
   * `sumAgentIterationsSince`, or one whose read throws, previously fell back
   * to `iterationsUsed = 0`, which made every run look like a fresh workspace
   * and silently disabled the durable ceiling entirely -- the failure mode
   * least likely to be noticed, since it looks exactly like normal operation.
   * Usage that cannot be measured is now reported as `usageKnown: false` and
   * the caller refuses the run rather than proceeding unbudgeted.
   *
   * @param {string} workspaceId
   * @param {object} [opts]
   * @param {number} [requestedIterations] iterations this run can actually
   *   perform; defaults to the configured per-call ceiling when not supplied.
   */
  _checkAgentLoopBudget(workspaceId, opts = {}, requestedIterations = null) {
    const maxIterationsPerWindow = Number.isInteger(opts.maxIterationsPerWindow) ? opts.maxIterationsPerWindow : this.maxIterationsPerWindow;
    const windowMs = Number.isInteger(opts.agentLoopBudgetWindowMs) ? opts.agentLoopBudgetWindowMs : this.agentLoopBudgetWindowMs;

    if (typeof this.storage?.sumAgentIterationsSince !== 'function') {
      return this._unavailableBudget(maxIterationsPerWindow, 'storage does not implement sumAgentIterationsSince');
    }

    let iterationsUsed;
    try {
      iterationsUsed = this.storage.sumAgentIterationsSince(workspaceId, Date.now() - windowMs);
    } catch (err) {
      return this._unavailableBudget(maxIterationsPerWindow, `usage lookup failed: ${err && err.message ? err.message : 'unknown error'}`);
    }

    // `null`, `undefined` and `''` all coerce to 0 through Number(), which
    // would read a missing counter as "nothing spent" -- the same fail-open
    // this method exists to close. Reject them before coercing.
    if (iterationsUsed === null || iterationsUsed === undefined || iterationsUsed === ''
      || !Number.isFinite(Number(iterationsUsed))) {
      return this._unavailableBudget(maxIterationsPerWindow, 'usage lookup returned a non-numeric value');
    }

    // Ask only for what this run can actually spend. Using the configured
    // per-call ceiling instead would project a run that can execute at most a
    // couple of steps as if it intended to spend all of them, tripping REVIEW
    // while most of the window budget is genuinely free.
    const requested = Number.isFinite(requestedIterations) && requestedIterations > 0
      ? requestedIterations
      : (Number.isInteger(opts.maxIterations) ? opts.maxIterations : this.maxIterations);

    const budgetDecision = evaluateAgentLoopBudget(
      { iterationsUsed: Number(iterationsUsed), requestedIterations: requested },
      { maxIterationsPerWindow },
    );
    emitGateTelemetry(this.kernel, 'agent-loop-budget', budgetDecision);

    return {
      ...budgetDecision,
      requestedIterations: requested,
      usageKnown: true,
    };
  }

  /**
   * Returns `opts` with the run's workspace forced onto the per-tool option
   * bags agent.js reads.
   *
   * The run-level workspace is authoritative and overrides a per-tool value
   * on purpose: the alternative is a run whose budget and run record name one
   * workspace while its steps mutate another, which makes the durable AB10
   * accounting describe a workspace that was never touched.
   */
  _withWorkspaceScope(opts = {}, workspaceId) {
    const scoped = { ...opts, workspaceId };
    for (const key of ['learnOpts', 'askOpts', 'verifyOpts', 'reasonOpts', 'compareOpts', 'dreamOpts']) {
      const existing = opts[key] && typeof opts[key] === 'object' && !Array.isArray(opts[key])
        ? opts[key]
        : {};
      scoped[key] = { ...existing, workspaceId };
    }
    return scoped;
  }

  _unavailableBudget(maxIterationsPerWindow, detail) {
    return {
      decision: 'block',
      reason: 'budget_usage_unavailable',
      detail,
      iterationsUsed: null,
      maxIterationsPerWindow,
      remaining: null,
      usageKnown: false,
    };
  }

  /**
   * Records an AB10 gate outcome. Audit persistence must not convert a
   * fail-closed refusal into a thrown exception, so a failing write is
   * swallowed here -- the same protection `kernel._appendAuditEvent` gives,
   * which this path bypasses by calling graph directly.
   *
   * graph.appendAuditEvent() is called directly rather than
   * kernel._appendAuditEvent(): KernelV2 is a facade over an internal Kernel
   * instance and does not proxy that private method, but both Kernel and
   * KernelV2 expose .graph identically, so this works for either kernel
   * implementation passed into AgentV3.
   */
  _recordBudgetAuditEvent(goal, workspaceId, budgetCheck) {
    if (!this.kernel?.graph || typeof this.kernel.graph.appendAuditEvent !== 'function') return;
    try {
      this.kernel.graph.appendAuditEvent({
        eventType: budgetCheck.decision === 'block' ? 'REJECT' : 'REVIEW',
        targetType: 'agent_loop_budget',
        targetId: goal,
        details: {
          gate: 'AB10',
          reason: budgetCheck.reason,
          iterationsUsed: budgetCheck.iterationsUsed,
          maxIterationsPerWindow: budgetCheck.maxIterationsPerWindow,
          usageKnown: budgetCheck.usageKnown !== false,
        },
      }, { workspaceId });
    } catch (_) {
      // Refusing the run is the safety behavior; losing its audit line must
      // not escalate into an exception that hides the refusal.
    }
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

  _storageFailure(operation, err, state = null) {
    const detail = err && err.message ? err.message : 'unknown error';
    return this._fail('agent', 'AGENT_STORAGE_ERROR',
      `Agent storage operation "${operation}" failed: ${detail}.`,
      state?.evidence || [], { operation }, state);
  }

  plan(goal, opts = {}) {
    const result = this.baseAgent.plan(goal, { ...opts, maxSteps: opts.maxSteps || this.maxSteps });
    if (!result || result.ok === false) return result;
    // Scoped: goal memory used to be global by goal text, so planning the same
    // goal returned another workspace's history (#757).
    const memory = this.storage.getGoalMemory(goal, opts.workspaceId);
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

  // The read half of the approval surface. inspectToolPolicy() writes through
  // the baseAgent seam above; these read straight from v3's storage, mirroring
  // the guards agent.js uses so a storage without the approval tables degrades
  // to empty rather than throwing.
  listPendingToolApprovals(limit = 20, workspaceId = 'default') {
    if (!this.storage || typeof this.storage.listPendingToolApprovals !== 'function') return [];
    return this.storage.listPendingToolApprovals(limit, workspaceId);
  }

  countPendingToolApprovals(workspaceId = 'default') {
    if (!this.storage || typeof this.storage.countPendingToolApprovals !== 'function') return 0;
    return this.storage.countPendingToolApprovals(workspaceId);
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
      if (state.dreamExperimentLoop && typeof state.dreamExperimentLoop === 'object') {
        state.dreamExperimentLoop = ensureState(state.dreamExperimentLoop, {
          workspaceId: state.workspaceId,
          goal: state.goal,
          checkpointId: state.checkpointId,
        });
      }
      state.completedSteps = Number(state.steps.length || 0);
      state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
      state.iteration = Number(state.iteration || state.steps.length || 0);
      // Remember where this run() picked up, so the durable run row can record
      // what this call actually spent rather than the whole running total.
      state.iterationsAtRunStart = state.iteration;
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
      iterationsAtRunStart: 0,
      budgetRemaining: this.timeBudgetMs,
      dreamExperimentLoop: null,
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
      // Must be carried explicitly: storage reads the workspace off this
      // object, not off the nested `state`, so omitting it would file every
      // checkpoint under 'default' and make workspace-scoped resume never
      // find anything.
      workspaceId: state.workspaceId,
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
    const scopeResult = createExecutionScope(goal, opts);
    if (!scopeResult.ok) return this._fail('agent', scopeResult.reason, 'Untrusted content cannot define an execution goal.', [], { goalBinding: scopeResult.receipt });
    const planResult = this.plan(goal, opts);
    if (!planResult || planResult.ok === false) return planResult;
    const activePlan = planResult.data;
    // Resolve the workspace before loading a checkpoint: checkpoints are
    // workspace-scoped, and looking one up by goal alone would let a run in
    // one workspace hydrate another workspace's paused state.
    const workspaceId = String(opts.workspaceId || 'default').trim() || 'default';
    const requestedCheckpointId = normalizeGoal(opts.checkpointId);
    const requestedResumeToken = normalizeGoal(opts.resumeToken);
    if (requestedCheckpointId || requestedResumeToken) {
      if (!requestedCheckpointId || !requestedResumeToken) {
        return this._fail('agent', 'AGENT_CONTINUATION_FIELDS_REQUIRED',
          'checkpointId and resumeToken must be supplied together.');
      }
      if (opts.resume === false) {
        return this._fail('agent', 'AGENT_CONTINUATION_REQUIRES_RESUME',
          'Explicit checkpoint continuation requires resume=true.');
      }
    }

    // Named selection beats recency: an explicit checkpointId must be
    // matched against the right goal and workspace rather than replaced
    // by the newest resumable row. Latest stays the default only when no
    // id is named, or the named row is not resumable under this scope.
    // (#880)
    let resumeRecord = null;
    if (opts.resume !== false) {
      try {
        if (requestedCheckpointId && typeof this.storage.loadCheckpoint === 'function') {
          resumeRecord = this.storage.loadCheckpoint(requestedCheckpointId, goal, workspaceId);
        }
        if (!resumeRecord) {
          resumeRecord = this.storage.loadLatestCheckpoint(goal, workspaceId);
        }
      } catch (err) {
        return this._storageFailure('loadLatestCheckpoint', err);
      }
    }
    if (requestedCheckpointId || requestedResumeToken) {
      const storedToken = resumeRecord?.state?.resumeToken || resumeRecord?.id || '';
      if (!resumeRecord || resumeRecord.id !== requestedCheckpointId || storedToken !== requestedResumeToken) {
        return this._fail('agent', 'AGENT_RESUME_TOKEN_INVALID',
          'The supplied checkpoint and resume token do not match a workspace-scoped checkpoint.', [], {
            checkpointId: requestedCheckpointId,
            workspaceId,
          });
      }
    }
    const state = this._hydrateState(activePlan, resumeRecord);
    state.executionScope = scopeResult.scope;
    const queued = Array.isArray(state.queuedSteps) ? [...state.queuedSteps] : [];
    const deadline = Date.now() + Math.max(0, Number.isInteger(opts.timeBudgetMs) ? opts.timeBudgetMs : this.timeBudgetMs);
    const maxIterations = Number.isInteger(opts.maxIterations) ? opts.maxIterations : this.maxIterations;
    state.workspaceId = workspaceId; state.agentId = String(opts.agentId || state.agentId || 'agent-v3');
    state.observabilityRunId = state.observabilityRunId || `agent-${crypto.randomUUID?.() || Date.now()}`;
    try { this.kernel?.observability?.recordLifecycle?.('beforeAgentRun', state); } catch (_) {}
    initializeBehavioralState(state, { goal: state.goal, workspaceId, agentId: state.agentId, selectedTools: state.selectedTools || activePlan.selectedTools, capabilities: (activePlan.steps || []).map(step => step.action) });
    // Keep the public plugin lifecycle contract reachable on the canonical v3
    // path. This intentionally precedes the durable budget gate: a before hook
    // observes every accepted run attempt, including one refused before work.
    this.baseAgent._emit('beforeAgentRun', state);

    // Force the run's workspace onto every tool call. agent.js reads
    // per-tool option bags straight through, so without this
    // a run could be budgeted and recorded against one workspace while its
    // steps actually read and mutate another -- making AB10's accounting
    // describe a workspace that was never touched. One run, one workspace.
    const scopedOpts = this._withWorkspaceScope(opts, workspaceId);
    const dreamLoopActive = loopEnabled({ ...opts, dreamExperimentLoop: opts.dreamExperimentLoop ?? this.dreamExperimentLoop }, this.kernel);
    const preparedDreamState = prepareDreamExperiment({
      active: dreamLoopActive,
      state,
      workspaceId,
      goal,
      checkpointId: state.checkpointId,
      opts,
    });
    if (preparedDreamState) state.dreamExperimentLoop = preparedDreamState;

    // AB10: durable, workspace-scoped ceiling on top of this call's own
    // maxIterations/timeBudgetMs (which only bound a single run()). Checked
    // BEFORE the loop starts so a workspace that already exhausted its
    // window's budget cannot spend a single further iteration by calling
    // run() again. REVIEW and BLOCK are both fail-closed here: agent.v3.js
    // has no approval-resume flow of its own (unlike the MCP-level gates),
    // so a caller must raise the budget or wait for the window to roll over
    // rather than silently proceeding.
    // Only ask the budget for the iterations this run can actually perform:
    // the loop below stops at the first of queued exhaustion, the plan's step
    // ceiling, or the per-call iteration ceiling.
    if (dreamLoopActive && !state.dreamExperimentLoop.hypotheses.length) {
      // The enabled loop owns its bounded cycle before legacy fallback steps.
      prepareDreamQueue(queued, state);
    }

    const runCapacity = Math.max(0, Math.min(
      queued.length,
      activePlan.maxSteps - state.steps.length,
      maxIterations - state.iteration,
    ));

    const budgetCheck = this._checkAgentLoopBudget(workspaceId, opts, runCapacity);

    // An unreadable usage counter is not the same failure as an exhausted
    // budget, and must not be reported as one -- the operator needs to know
    // the ceiling could not be evaluated at all.
    if (budgetCheck.usageKnown === false) {
      this._recordBudgetAuditEvent(goal, workspaceId, budgetCheck);
      return this._fail('agent', 'AGENT_LOOP_BUDGET_UNAVAILABLE',
        `Agent loop budget could not be evaluated for workspace "${workspaceId}": ${budgetCheck.detail}. Refusing the run rather than proceeding unbudgeted.`,
        [], { gate: 'AB10', budget: budgetCheck });
    }

    if (budgetCheck.decision !== 'allow') {
      this._recordBudgetAuditEvent(goal, workspaceId, budgetCheck);
      return this._fail('agent', 'AGENT_LOOP_BUDGET_EXCEEDED',
        `Agent loop budget ${budgetCheck.decision} for workspace "${workspaceId}": ${budgetCheck.reason} (${budgetCheck.iterationsUsed}/${budgetCheck.maxIterationsPerWindow} iterations used this window).`,
        [], { gate: 'AB10', budget: budgetCheck });
    }

    try {
      this._saveCheckpoint(state);
    } catch (err) {
      return this._storageFailure('saveCheckpoint', err, state);
    }

    while (queued.length > 0 && state.steps.length < activePlan.maxSteps && state.iteration < maxIterations) {
      if (Date.now() >= deadline) {
        state.status = 'paused';
        state.pauseReason = 'time_budget_exceeded';
        break;
      }

      const step = queued.shift();
      const report = this.baseAgent._executeStepWithRetry(step, state, scopedOpts);
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

      let loopHandled = false;
      if (dreamLoopActive && (step.tool === 'dream' || isDreamExperimentVerificationStep(step))) {
        const loopResult = processDreamStep(this.kernel, state.dreamExperimentLoop, { step, report }, {
          workspaceId,
          goal,
          checkpointId: state.checkpointId,
          maxHypotheses: opts.dreamExperimentMaxHypotheses,
          maxCycles: opts.dreamExperimentMaxCycles,
          experimentId: opts.dreamExperimentId,
          admissionOpts: opts.dreamExperimentAdmissionOpts,
        });
        state.dreamExperimentLoop = loopResult.state;
        loopHandled = loopResult.handled;
        if (loopResult.nextStep && state.steps.length < activePlan.maxSteps) queued.unshift(loopResult.nextStep);
        if (loopResult.blocked) {
          state.status = 'blocked';
          state.blockedBy = 'dream-experiment-loop';
          state.blockReason = loopResult.state.lastError?.message || 'Dream experiment loop durability failed.';
          queued.length = 0;
        }
      }

      const effectiveFollowUp = loopHandled ? null : followUp;
      if (shouldForceDream && !loopHandled) {
        queued.unshift({
          id: `dream-${state.steps.length + 1}`,
          action: 'dream',
          tool: 'dream',
          input: {},
          rationale: 'Progress stalled; switching to hypothesis mode.',
        });
      } else if (effectiveFollowUp && state.steps.length < activePlan.maxSteps) {
        const nextSignature = this.baseAgent._stepSignature(effectiveFollowUp, state);
        if (this.baseAgent._findRecentFailure(nextSignature)) {
          const fallback = effectiveFollowUp.action === 'dream'
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
            id: `${effectiveFollowUp.action}-${state.steps.length + 1}`,
            action: effectiveFollowUp.action,
            tool: effectiveFollowUp.tool,
            input: effectiveFollowUp.input,
            rationale: 'Previous step produced a follow-up need.',
          });
        }
      }

      state.queuedSteps = [...queued];
      state.completedSteps = state.steps.length;
      state.remainingSteps = queued.length;
      state.budgetRemaining = Math.max(0, deadline - Date.now());
      try {
        this._saveCheckpoint(state);
      } catch (err) {
        return this._storageFailure('saveCheckpoint', err, state);
      }
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
    state.recommendations = this.baseAgent._buildRunRecommendations(state);
    state.nextAction = selectDreamNextAction(
      dreamLoopActive,
      state,
      this.baseAgent._suggestNextAction(state),
    );
    state.report = this._renderReport(state);
    let goalMemory;
    let runs;
    try {
      goalMemory = this.storage.getGoalMemory(goal, workspaceId);
      runs = this.storage.countRuns();
    } catch (err) {
      return this._storageFailure('readRunMemory', err, state);
    }
    state.memory = { path: this.storage.dbPath, goalMemory, runs };
    state.checkpointId = state.checkpointId || state.resumeToken || null;
    state.resumeToken = state.checkpointId;

    // What this run() spent, not the goal's running total: summing the
    // cumulative figure would count a resumed run's earlier iterations again
    // on every resume, exhausting the window budget long before it was
    // genuinely spent.
    state.iterationsDelta = Math.max(0, Number(state.iteration || 0) - Number(state.iterationsAtRunStart || 0));

    try {
      this.storage.saveRun(state);
    } catch (err) {
      return this._storageFailure('saveRun', err, state);
    }
    try {
      this.storage.saveGoalMemory({
        goal,
        workspaceId,
        objective: activePlan.objective,
        status: state.status,
        completedSteps: state.completedSteps,
        finalAnswer: state.finalAnswer,
        resumed: state.resumed,
        selectedTools: activePlan.selectedTools,
      });
    } catch (err) {
      return this._storageFailure('saveGoalMemory', err, state);
    }

    if (state.status === 'completed' || state.status === 'blocked') {
      try {
        this.storage.deleteCheckpoint(state.checkpointId, goal, workspaceId);
      } catch (err) {
        return this._storageFailure('deleteCheckpoint', err, state);
      }
    } else {
      try {
        this._saveCheckpoint(state);
      } catch (err) {
        return this._storageFailure('saveCheckpoint', err, state);
      }
    }

    this.lastRun = state;

    if (state.status === 'completed' || state.status === 'blocked') {
      this.baseAgent._emit('afterAgentRun', state);
    }

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

  getStatus(workspaceId = 'default') {
    const goals = this.storage ? this.storage.countGoals() : 0;
    const checkpoints = this.storage ? this.storage.countCheckpoints() : 0;
    const runs = this.storage ? this.storage.countRuns() : 0;
    const pendingApprovals = this.storage && typeof this.storage.countPendingToolApprovals === 'function'
      ? this.storage.countPendingToolApprovals(workspaceId)
      : 0;
    const recentApprovals = this.storage && typeof this.storage.listPendingToolApprovals === 'function'
      ? this.storage.listPendingToolApprovals(5, workspaceId).map(item => ({
          id: item.id,
          tool: item.tool,
          status: item.status,
          approvalKey: item.approval_key || item.approvalKey || null,
        }))
      : [];
    return {
      agent: 'v3',
      goals,
      checkpoints,
      runs,
      pendingApprovals,
      recentApprovals,
      lastPlan: this.lastPlan
        ? { goal: this.lastPlan.goal, steps: this.lastPlan.steps.length }
        : null,
      lastRun: this.lastRun
        ? {
            status: this.lastRun.status,
            goal: this.lastRun.goal,
            completedSteps: this.lastRun.completedSteps,
            resumeToken: this.lastRun.resumeToken || null,
            remainingSteps: this.lastRun.remainingSteps,
            finalAnswer: this.lastRun.finalAnswer
          }
        : null
    };
  }
}

module.exports = AgentV3;
