'use strict';

// Reads and bookkeeping over the legacy agent's memory object: goal keys, goal
// and resumable-run lookup, tool and objective stats, pruning, failure lookup.
// Moved out of agent.js (#2130) unchanged; the methods that write memory to disk
// or storage stay on the Agent class.
const { lower, defaultMemoryState } = require('./agent-memory-state');

const MEMORY_LIMITS = {
  plans: 24,
  runs: 32,
  goals: 64,
};
function normalizeMemory(memory = {}) {
  const base = defaultMemoryState();
  const normalized = {
    ...base,
    ...memory,
    plans: Array.isArray(memory.plans) ? memory.plans : [],
    runs: Array.isArray(memory.runs) ? memory.runs : [],
    goals: Array.isArray(memory.goals) ? memory.goals : [],
    failures: Array.isArray(memory.failures) ? memory.failures : [],
    stats: {
      tools: memory.stats && typeof memory.stats.tools === 'object' && memory.stats.tools ? memory.stats.tools : {},
      objectives: memory.stats && typeof memory.stats.objectives === 'object' && memory.stats.objectives ? memory.stats.objectives : {},
    },
  };
  return normalized;
}

function goalKey(goal) {
  return lower(goal);
}

function findGoalRecord(memory, goal) {
  const key = goalKey(goal);
  for (let i = memory.goals.length - 1; i >= 0; i -= 1) {
    const entry = memory.goals[i];
    if (entry && entry.key === key) return entry;
  }
  return null;
}

function findResumeRun(memory, goal) {
  const key = goalKey(goal);
  for (let i = memory.runs.length - 1; i >= 0; i -= 1) {
    const entry = memory.runs[i];
    if (!entry || entry.key !== key) continue;
    if (entry.status === 'completed') continue;
    if (!Array.isArray(entry.queuedSteps) || entry.queuedSteps.length === 0) continue;
    return entry;
  }
  return null;
}

function updateToolStats(memory, tool, status) {
  if (!tool) return;
  const bucket = memory.stats.tools[tool] || { planned: 0, success: 0, blocked: 0, error: 0 };
  bucket.planned += 1;
  if (status === 'done') bucket.success += 1;
  else if (status === 'blocked') bucket.blocked += 1;
  else if (status === 'error') bucket.error += 1;
  memory.stats.tools[tool] = bucket;
}

function updateObjectiveStats(memory, objective, status) {
  if (!objective) return;
  const bucket = memory.stats.objectives[objective] || { plans: 0, completed: 0, blocked: 0, error: 0 };
  bucket.plans += 1;
  if (status === 'completed') bucket.completed += 1;
  else if (status === 'blocked') bucket.blocked += 1;
  else if (status === 'error') bucket.error += 1;
  memory.stats.objectives[objective] = bucket;
}

function pruneMemory(memory) {
  memory.plans = memory.plans.slice(-MEMORY_LIMITS.plans);
  memory.runs = memory.runs.slice(-MEMORY_LIMITS.runs);
  memory.goals = memory.goals.slice(-MEMORY_LIMITS.goals);
  memory.failures = memory.failures.slice(-MEMORY_LIMITS.goals);
}

function findRecentFailure(memory, signature) {
  const key = String(signature || '');
  for (let i = memory.failures.length - 1; i >= 0; i -= 1) {
    const entry = memory.failures[i];
    if (entry && entry.signature === key) return entry;
  }
  return null;
}

module.exports = {
  MEMORY_LIMITS,
  normalizeMemory,
  goalKey,
  findGoalRecord,
  findResumeRun,
  updateToolStats,
  updateObjectiveStats,
  pruneMemory,
  findRecentFailure,
};
