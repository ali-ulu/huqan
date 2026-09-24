'use strict';

/**
 * DelegationService v0: the single future boundary for multi-task delegation
 * (#2505/E1).
 *
 * v0 validates only. It evaluates a caller-supplied delegation plan with the
 * cascade guard's own plan validation and returns a frozen, receipt-compatible
 * verdict. No execution is rerouted through anything in this slice; existing
 * execution paths are untouched, and the guard's `run()` is not called here.
 *
 * The guard stays a coordinator, never a planner: the plan (task ids, owning
 * agents, dependencies) arrives built, and this service answers whether it is
 * structurally admissible (bounded fan-out, known dependencies, no cycles,
 * no self-dependency, no duplicates, plus spawn bounds below). Policy verdicts
 * (allow/review/block), a plan compiler, execution rerouting, and a
 * review/HITL state machine are explicitly deferred slices, in that order.
 *
 * Spawn bounds (#2505/E, count/depth/agents) are structural and enforced here
 * at validation time; the verdict records the measured values next to the
 * bounds so a receipt can carry them. Rate (spawns per window) is explicitly
 * deferred: it needs an execution lifecycle with a clock, and v0 has neither
 * by owner decision (no run() here, no rerouted execution).
 */

const { REASONS, validatePlan } = require('./multi-agent-cascade-guard');

const DEFAULT_MAX_FAN_OUT = 4;
const DEFAULT_MAX_TASKS = 16;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_AGENTS = 8;

function boundedInteger(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function createDelegationService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const maxFanOut = options.maxFanOut === undefined ? DEFAULT_MAX_FAN_OUT : options.maxFanOut;
  if (!Number.isInteger(maxFanOut) || maxFanOut < 1 || maxFanOut > 64) {
    throw new TypeError('maxFanOut must be an integer between 1 and 64');
  }
  const maxTasks = boundedInteger(options.maxTasks, DEFAULT_MAX_TASKS, 'maxTasks', 1, 64);
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth', 1, 16);
  const maxAgents = boundedInteger(options.maxAgents, DEFAULT_MAX_AGENTS, 'maxAgents', 1, 32);

  return Object.freeze({ evaluatePlan });

  function evaluatePlan(plan) {
    const tasks = Array.isArray(plan) ? plan : plan && plan.tasks;
    let validated;
    try {
      validated = validatePlan(tasks, maxFanOut);
    } catch (error) {
      return Object.freeze({
        ok: false,
        reason: REASONS.INVALID_PLAN,
        error: String((error && error.message) || error),
        tasks: Object.freeze([]),
      });
    }
    const roots = validated.plan.filter((task) => task.dependsOn.length === 0).length;
    const distinctAgents = new Set(validated.plan.map((task) => task.agentId)).size;
    const depth = longestChain(validated.plan);
    const bound = checkSpawnBounds(validated.plan.length, depth, distinctAgents);
    if (bound) {
      return Object.freeze({
        ok: false,
        reason: REASONS.INVALID_PLAN,
        error: bound,
        tasks: Object.freeze([]),
      });
    }
    return Object.freeze({
      ok: true,
      reason: 'DELEGATION_PLAN_VALID',
      tasks: Object.freeze(validated.plan.map((task) => Object.freeze({
        id: task.id,
        agentId: task.agentId,
        dependsOn: task.dependsOn,
      }))),
      taskCount: validated.plan.length,
      rootCount: roots,
      maxFanOut,
      distinctAgents,
      depth,
      maxTasks,
      maxDepth,
      maxAgents,
    });
  }

  function checkSpawnBounds(taskCount, depth, distinctAgents) {
    if (taskCount > maxTasks) return `task count ${taskCount} exceeds maxTasks ${maxTasks}`;
    if (depth > maxDepth) return `plan depth ${depth} exceeds maxDepth ${maxDepth}`;
    if (distinctAgents > maxAgents) return `distinct agents ${distinctAgents} exceeds maxAgents ${maxAgents}`;
    return null;
  }
}

function longestChain(plan) {
  const byId = new Map(plan.map((task) => [task.id, task]));
  const memo = new Map();
  const visit = (id) => {
    if (memo.has(id)) return memo.get(id);
    const task = byId.get(id);
    if (!task || task.dependsOn.length === 0) {
      memo.set(id, 1);
      return 1;
    }
    const value = 1 + Math.max(...task.dependsOn.map(visit));
    memo.set(id, value);
    return value;
  };
  return Math.max(...plan.map((task) => visit(task.id)));
}

module.exports = {
  createDelegationService,
  DEFAULT_MAX_FAN_OUT,
  DEFAULT_MAX_TASKS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_AGENTS,
};
