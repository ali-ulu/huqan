const crypto = require('crypto');
const { createExecutionScope } = require('./lib/goal-binding');
const Agent = require('./agent');
const { normalizeAgentV3WorkspaceId } = require('./lib/agent-v3-workspace');
const { createDefaultAgentV3Storage } = require('./lib/agent-v3-storage-factory');
const { DEFAULT_MAX_ITERATIONS_PER_WINDOW, DEFAULT_WINDOW_MS } = require('./lib/agent-v3-loop-budget');
const { initializeBehavioralState } = require('./lib/agent-behavioral-integrity');
const { loopEnabled, isDreamExperimentVerificationStep, prepareDreamExperiment, prepareDreamQueue, processDreamStep } = require('./lib/agent-v3-dream-loop-adapter');
const { normalizeGoal, createToolApprovalSeam } = require('./lib/agent-v3-approval-methods');
const { installAgentV3Methods } = require('./lib/agent-v3-method-install');
const { AgentV3BudgetMethods } = require('./lib/agent-v3-budget-methods');
const { AgentV3ResultMethods } = require('./lib/agent-v3-result-methods');
const { AgentV3ApprovalMethods } = require('./lib/agent-v3-approval-methods');
const { AgentV3StatusMethods } = require('./lib/agent-v3-status-methods');
const { AgentV3PlanMethods } = require('./lib/agent-v3-plan-methods');

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
      experienceOperationLedger: opts.experienceOperationLedger,
    });
    this.storage = opts.storage || createDefaultAgentV3Storage(this.kernel, opts);
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
   * Records an AB10 gate outcome. Audit persistence must not convert a
   * fail-closed refusal into a thrown exception, so a failing write is
   * swallowed here -- the same protection kernel._appendAuditEvent gives,
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



  run(goal, opts = {}) {
    const scopeResult = createExecutionScope(goal, opts);
    if (!scopeResult.ok) return this.fail('agent', scopeResult.reason, 'Untrusted content cannot define an execution goal.', [], { goalBinding: scopeResult.receipt });
    const planResult = this.plan(goal, opts);
    if (!planResult || planResult.ok === false) return planResult;
    const activePlan = planResult.data;
    // Resolve the workspace before loading a checkpoint: checkpoints are
    // workspace-scoped, and looking one up by goal alone would let a run in
    // one workspace hydrate another workspace's paused state.
    const workspace = normalizeAgentV3WorkspaceId(opts.workspaceId);
    if (!workspace.ok) return this.fail('agent', 'AGENT_WORKSPACE_ID_INVALID', workspace.message, [], { workspaceId: opts.workspaceId });
    const workspaceId = workspace.workspaceId;
    const requestedCheckpointId = normalizeGoal(opts.checkpointId);
    const requestedResumeToken = normalizeGoal(opts.resumeToken);
    if (requestedCheckpointId || requestedResumeToken) {
      if (!requestedCheckpointId || !requestedResumeToken) {
        return this.fail('agent', 'AGENT_CONTINUATION_FIELDS_REQUIRED',
          'checkpointId and resumeToken must be supplied together.');
      }
      if (opts.resume === false) {
        return this.fail('agent', 'AGENT_CONTINUATION_REQUIRES_RESUME',
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
        return this.fail('agent', 'AGENT_RESUME_TOKEN_INVALID',
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
    this._runtime().emit('beforeAgentRun', state);

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

    // A resume with nothing left to run (stopped in finalization) spends no
    // iteration, but the budget reads a zero capacity as unknown and projects
    // the whole per-call ceiling. Ask for one, the least any evaluated run is
    // charged, so an exhausted window still refuses it.
    const budgetCheck = this._checkAgentLoopBudget(workspaceId, opts, Math.max(1, runCapacity));

    // An unreadable usage counter is not the same failure as an exhausted
    // budget, and must not be reported as one -- the operator needs to know
    // the ceiling could not be evaluated at all.
    if (budgetCheck.usageKnown === false) {
      this._recordBudgetAuditEvent(goal, workspaceId, budgetCheck);
      return this.fail('agent', 'AGENT_LOOP_BUDGET_UNAVAILABLE',
        `Agent loop budget could not be evaluated for workspace "${workspaceId}": ${budgetCheck.detail}. Refusing the run rather than proceeding unbudgeted.`,
        [], { gate: 'AB10', budget: budgetCheck });
    }

    if (budgetCheck.decision !== 'allow') {
      this._recordBudgetAuditEvent(goal, workspaceId, budgetCheck);
      return this.fail('agent', 'AGENT_LOOP_BUDGET_EXCEEDED',
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
      const report = this._runtime().executeStepWithRetry(step, state, scopedOpts);
      state.steps.push(report);
      state.evidence.push(...this._runtime().collectEvidence([report.result]));
      this._runtime().updateToolStats(report.tool, report.status);
      state.notes.push({
        step: report.action,
        summary: report.summary,
      });
      state.iteration += 1;
      state.lastAction = report.action;

      const summary = this._runtime().extractAgentSummary(report.result);
      const previousSummary = state.progress?.lastSummary || '';
      const stalled = this._runtime().isStalledProgress(previousSummary, summary.text);
      state.progress = {
        stalledCount: stalled ? (state.progress?.stalledCount || 0) + 1 : 0,
        lastSummary: String(summary.text || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      };

      const followUp = this._runtime().chooseFollowUp(step, summary, state);
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
        const nextSignature = this._runtime().stepSignature(effectiveFollowUp, state);
        if (this._runtime().findRecentFailure(nextSignature)) {
          const fallback = effectiveFollowUp.action === 'dream'
            ? null
            : { action: 'dream', tool: 'dream', input: {}, rationale: 'Previous failure repeated; safe fallback selected.' };
          if (fallback && !this._runtime().findRecentFailure(this._runtime().stepSignature(fallback, state))) {
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

    const runFinal = this._finalizeRunState(state, { goal, workspaceId, activePlan, dreamLoopActive, queued });
    if (runFinal.failed) return runFinal.result;


    this.lastRun = state;

    if (state.status === 'completed' || state.status === 'blocked') {
      this._runtime().emit('afterAgentRun', state);
    }

    if (state.status === 'blocked') {
      return this.fail('agent', 'AGENT_BLOCKED', state.finalAnswer, state.evidence, {
        objective: activePlan.objective,
        selectedTools: activePlan.selectedTools,
        resumed: state.resumed,
        report: state.report,
        checkpointId: state.checkpointId,
        resumeToken: state.resumeToken,
      }, state);
    }

    return this.ok('agent', state, state.evidence, {
      objective: activePlan.objective,
      selectedTools: activePlan.selectedTools,
      resumed: state.resumed,
      checkpointId: state.checkpointId,
      resumeToken: state.resumeToken,
      paused: state.status === 'paused',
    });
  }

}

installAgentV3Methods(AgentV3, AgentV3BudgetMethods);
installAgentV3Methods(AgentV3, AgentV3ResultMethods);
installAgentV3Methods(AgentV3, AgentV3ApprovalMethods);
installAgentV3Methods(AgentV3, AgentV3StatusMethods);
installAgentV3Methods(AgentV3, AgentV3PlanMethods);

module.exports = AgentV3;
