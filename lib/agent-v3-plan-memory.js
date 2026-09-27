'use strict';

/**
 * Goal-memory annotation for AgentV3's plan(). Extracted from agent.v3.js,
 * which sat at its recorded line-size ceiling, so the hardening around the
 * workspace-scoped read (#757) fits there without growing the file.
 *
 * normalizeGoal/lower are the storage layer's own key helpers, reused here so
 * the plan's reported goal/key cannot drift from the ones getGoalMemory keys
 * on.
 */

const { normalizeGoal, lower } = require('./storage/run-state-keys');

function emptyGoalMemory() {
  return {
    successCount: 0,
    blockedCount: 0,
    errorCount: 0,
    resumedCount: 0,
    lastStatus: 'unknown',
    pattern: {},
  };
}

function buildGoalMemoryBlock(memory, goal) {
  return {
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
      : emptyGoalMemory(),
  };
}

/** Attach the workspace-scoped goal-memory block to a plan and flag it as a
 * policy signal when history exists. Mutates and returns `data`. */
function annotatePlanWithGoalMemory(data, memory, goal) {
  data.memory = { ...(data.memory || {}), storage: buildGoalMemoryBlock(memory, goal) };
  if (memory && data.policy && Array.isArray(data.policy.signals) && !data.policy.signals.includes('goal-memory')) {
    data.policy.signals.push('goal-memory');
  }
  return data;
}

module.exports = { annotatePlanWithGoalMemory, buildGoalMemoryBlock };
