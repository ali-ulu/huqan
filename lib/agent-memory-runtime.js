'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cloneValue, nowIso, normalizeGoal, defaultMemoryState } = require('./agent-memory-state');
const { noteMemoryFailure } = require('./agent-memory-persistence');
const { normalizeMemory, goalKey, findGoalRecord, findResumeRun, updateToolStats, updateObjectiveStats, pruneMemory, findRecentFailure } = require('./agent-memory-records');
const { stepFailureSignature } = require('./agent-failure-signature');

// Committing an atomic save renames a brand-new temp file, and on Windows
// that rename can fail with a transient EPERM/EBUSY/EACCES while an
// antivirus/indexer scan holds the fresh file — even though nothing is
// wrong with the write itself (#2868). The save is idempotent (same
// payload, fresh temp name per attempt), so a small bounded retry absorbs
// the OS noise instead of reporting a persistence failure that flips
// memory-health envelopes and golden digests. A genuinely stuck
// destination still fails closed via noteMemoryFailure after the budget.
const SAVE_RETRY_ATTEMPTS = 5;
const SAVE_RETRY_BASE_MS = 10;
const SAVE_RETRY_MAX_MS = 50;

function isTransientSaveError(error) {
  return !!error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES');
}

function sleepSyncMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const memoryRuntime = {
  _loadMemory() {
    if (!this.memoryPath || !fs.existsSync(this.memoryPath)) return defaultMemoryState();
    try { return this._normalizeMemory(JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'))); } catch (error) {
      const backupPath = `${this.memoryPath}.corrupt-${crypto.randomUUID()}`;
      fs.renameSync(this.memoryPath, backupPath);
      const corruptError = new Error(`Agent memory is corrupt; original moved to ${backupPath}`);
      corruptError.cause = error;
      throw corruptError;
    }
  },
  _normalizeMemory(memory = {}) { return normalizeMemory(memory); },
  _saveMemory() {
    if (!this.memoryPath) return;
    let delay = SAVE_RETRY_BASE_MS;
    for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt += 1) {
      let tempPath;
      try {
        const dir = path.dirname(this.memoryPath);
        if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
        tempPath = path.join(dir, `.${path.basename(this.memoryPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(tempPath, JSON.stringify(this.memory, null, 2));
        fs.renameSync(tempPath, this.memoryPath);
        return;
      } catch (error) {
        if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
        if (!isTransientSaveError(error) || attempt >= SAVE_RETRY_ATTEMPTS) {
          noteMemoryFailure(this, 'saveMemory', error);
          return;
        }
        sleepSyncMs(delay);
        delay = Math.min(delay * 2, SAVE_RETRY_MAX_MS);
      }
    }
  },
  _goalKey(goal) { return goalKey(goal); },
  _findGoalRecord(goal) { return findGoalRecord(this.memory, goal); },
  _findResumeRun(goal) { return findResumeRun(this.memory, goal); },
  _updateToolStats(tool, status) { updateToolStats(this.memory, tool, status); },
  _updateObjectiveStats(objective, status) { updateObjectiveStats(this.memory, objective, status); },
  _pruneMemory() { pruneMemory(this.memory); },
  _recordGoal(goal, objective, status, meta = {}) {
    const entry = { key: this._goalKey(goal), goal: normalizeGoal(goal), objective, status, updatedAt: nowIso(), ...meta };
    this.memory.goals.push(entry); this._pruneMemory();
    if (this.storage?.saveGoalMemory) {
      try { this.storage.saveGoalMemory({ goal: entry.goal, objective, status, completedSteps: meta.completedSteps || 0, finalAnswer: meta.finalAnswer || '', resumed: Boolean(meta.resumed), selectedTools: meta.selectedTools || [] }); } catch (error) { noteMemoryFailure(this, 'saveGoalMemory', error); }
    }
  },
  _stepSignature(step = {}, state = {}) { return stepFailureSignature(step, state); },
  _findRecentFailure(signature) { return findRecentFailure(this.memory, signature); },
  _recordFailure(step, state, result, attempt = 1) {
    const entry = { signature: this._stepSignature(step, state), tool: step.tool, action: step.action, goal: normalizeGoal(state.goal), error: result?.error?.message || result?.error?.code || result?.error || 'unknown', attempt, updatedAt: nowIso() };
    this.memory.failures.push(entry); this._pruneMemory(); this._saveMemory(); return entry;
  },
  _rememberPlan(plan, meta = {}) {
    const entry = { id: crypto.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`, goal: plan.goal, key: this._goalKey(plan.goal), objective: plan.objective, selectedTools: Array.isArray(plan.selectedTools) ? [...plan.selectedTools] : [], steps: Array.isArray(plan.steps) ? cloneValue(plan.steps) : [], status: plan.status || 'planned', confidence: plan.confidence, rationale: plan.rationale, policy: plan.policy ? cloneValue(plan.policy) : undefined, memory: plan.memory ? cloneValue(plan.memory) : undefined, createdAt: nowIso(), updatedAt: nowIso(), ...meta };
    this.memory.plans.push(entry); this._recordGoal(plan.goal, plan.objective, 'planned', { selectedTools: entry.selectedTools }); this._pruneMemory(); this._saveMemory(); return entry;
  },
  _rememberRun(state) {
    const entry = { id: state.memoryId || state.id || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`, goal: state.goal, key: this._goalKey(state.goal), objective: state.objective, selectedTools: Array.isArray(state.selectedTools) ? [...state.selectedTools] : [], steps: cloneValue(state.steps || []), queuedSteps: cloneValue(state.queuedSteps || []), evidence: cloneValue(state.evidence || []), notes: cloneValue(state.notes || []), plan: state.plan ? cloneValue(state.plan) : null, status: state.status, finalAnswer: state.finalAnswer, completedSteps: state.completedSteps || 0, remainingSteps: state.remainingSteps || 0, report: state.report || '', resumed: Boolean(state.resumed), resumedFrom: state.resumedFrom || null, progress: state.progress ? cloneValue(state.progress) : { stalledCount: 0, lastSummary: '' }, startedAt: state.startedAt || nowIso(), updatedAt: nowIso() };
    const index = this.memory.runs.findIndex(run => run.id === entry.id);
    if (index >= 0) this.memory.runs[index] = entry; else this.memory.runs.push(entry);
    this._updateObjectiveStats(entry.objective, state.status);
    this._recordGoal(entry.goal, entry.objective, state.status, { selectedTools: entry.selectedTools, finalAnswer: entry.finalAnswer, resumed: entry.resumed, completedSteps: entry.completedSteps });
    this._pruneMemory(); this._saveMemory();
    if (this.storage?.saveRun) { try { this.storage.saveRun({ ...entry, checkpointId: state.checkpointId || state.resumeToken || null, resumeToken: state.resumeToken || null, iteration: state.steps ? state.steps.length : 0, budgetRemaining: state.budgetRemaining || 0 }); } catch (error) { noteMemoryFailure(this, 'saveRun', error); } }
    return entry;
  },
};

module.exports = { memoryRuntime };
