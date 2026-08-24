'use strict';

/*
 * A transport-independent coordinator for a bounded set of agent tasks.
 *
 * It deliberately does not create agents, queues, or network transports. A
 * host supplies the task executor, while this module owns the safety policy
 * that has to stay identical across those hosts: bounded fan-out, dependency
 * isolation, a per-agent circuit breaker, and bounded retries.
 */

const REASONS = Object.freeze({
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  DEPENDENCY_FAILED: 'DEPENDENCY_FAILED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  INVALID_PLAN: 'INVALID_PLAN',
});

function positiveInteger(value, fallback, name, maximum = 64) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value, fallback, name, maximum = 600000) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function taskId(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function snapshotTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('each task must be an object');
  const id = taskId(task.id, 'task.id');
  const agentId = taskId(task.agentId, 'task.agentId');
  const dependsOn = task.dependsOn === undefined ? [] : task.dependsOn;
  if (!Array.isArray(dependsOn)) throw new TypeError('task.dependsOn must be an array');
  const dependencies = dependsOn.map((dependency) => taskId(dependency, 'task.dependsOn entry'));
  if (new Set(dependencies).size !== dependencies.length) throw new TypeError(`task ${id} repeats a dependency`);
  if (dependencies.includes(id)) throw new TypeError(`task ${id} cannot depend on itself`);
  return Object.freeze({ id, agentId, dependsOn: Object.freeze(dependencies), input: task.input });
}

function validatePlan(tasks, maxFanOut) {
  if (!Array.isArray(tasks) || !tasks.length) throw new TypeError('tasks must be a non-empty array');
  const plan = tasks.map(snapshotTask);
  const byId = new Map();
  for (const task of plan) {
    if (byId.has(task.id)) throw new TypeError(`task id ${task.id} is duplicated`);
    byId.set(task.id, task);
  }
  const children = new Map(plan.map((task) => [task.id, []]));
  let roots = 0;
  for (const task of plan) {
    if (!task.dependsOn.length) roots += 1;
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new TypeError(`task ${task.id} depends on unknown task ${dependency}`);
      children.get(dependency).push(task.id);
    }
  }
  if (roots > maxFanOut) throw new TypeError(`root fan-out exceeds ${maxFanOut}`);
  for (const [id, descendants] of children) {
    if (descendants.length > maxFanOut) throw new TypeError(`task ${id} fan-out exceeds ${maxFanOut}`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`task dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of plan) visit(task.id);
  return { plan, byId };
}

function createMultiAgentCascadeGuard(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const maxFanOut = positiveInteger(options.maxFanOut, 4, 'maxFanOut');
  const failureThreshold = positiveInteger(options.failureThreshold, 2, 'failureThreshold', 16);
  const failureWindowMs = nonNegativeInteger(options.failureWindowMs, 60000, 'failureWindowMs');
  const cooldownMs = nonNegativeInteger(options.cooldownMs, 300000, 'cooldownMs');
  const maxRetries = nonNegativeInteger(options.maxRetries, 1, 'maxRetries', 8);
  const now = options.now === undefined ? () => Date.now() : options.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const failures = new Map();

  function prune(agentId, timestamp) {
    const retained = (failures.get(agentId) || []).filter((entry) => timestamp - entry.at <= failureWindowMs);
    if (retained.length) failures.set(agentId, retained);
    else failures.delete(agentId);
    return retained;
  }

  function breaker(agentId, timestamp) {
    const recent = prune(agentId, timestamp);
    const latest = recent[recent.length - 1];
    if (recent.length < failureThreshold || !latest || timestamp - latest.at >= cooldownMs) return null;
    return Object.freeze({ reason: REASONS.CIRCUIT_OPEN, retryAt: latest.at + cooldownMs });
  }

  function recordFailure(agentId, timestamp) {
    const recent = prune(agentId, timestamp);
    recent.push({ at: timestamp });
    failures.set(agentId, recent);
  }

  async function executeTask(task, executor) {
    const circuit = breaker(task.agentId, now());
    if (circuit) return { status: 'blocked', reason: circuit.reason, retryAt: circuit.retryAt, attempts: 0 };
    let attempts = 0;
    let lastError = null;
    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const result = await executor(Object.freeze({ ...task }), Object.freeze({ attempt: attempts }));
        if (result && result.ok !== false) return { status: 'completed', attempts, result };
        lastError = result?.error || { code: REASONS.EXECUTION_FAILED, retryable: false };
      } catch (error) {
        lastError = { code: error?.code || REASONS.EXECUTION_FAILED, retryable: error?.retryable === true };
      }
      if (lastError?.retryable !== true || attempts > maxRetries) break;
    }
    recordFailure(task.agentId, now());
    return { status: 'failed', reason: lastError?.code || REASONS.EXECUTION_FAILED, attempts };
  }

  async function run(tasks, executor) {
    if (typeof executor !== 'function') throw new TypeError('executor must be a function');
    let validated;
    try {
      validated = validatePlan(tasks, maxFanOut);
    } catch (error) {
      return Object.freeze({ ok: false, reason: REASONS.INVALID_PLAN, error: error.message, tasks: Object.freeze([]) });
    }
    const pending = new Set(validated.plan.map((task) => task.id));
    const outcomes = new Map();
    while (pending.size) {
      const ready = validated.plan.filter((task) => pending.has(task.id)
        && task.dependsOn.every((dependency) => outcomes.has(dependency)));
      if (!ready.length) {
        for (const id of pending) outcomes.set(id, { status: 'blocked', reason: REASONS.DEPENDENCY_FAILED, attempts: 0 });
        break;
      }
      for (const task of ready) {
        pending.delete(task.id);
        const failedDependency = task.dependsOn.find((dependency) => outcomes.get(dependency).status !== 'completed');
        if (failedDependency) {
          outcomes.set(task.id, { status: 'blocked', reason: REASONS.DEPENDENCY_FAILED, dependency: failedDependency, attempts: 0 });
          continue;
        }
        outcomes.set(task.id, await executeTask(task, executor));
      }
    }
    const report = validated.plan.map((task) => Object.freeze({ id: task.id, agentId: task.agentId, ...outcomes.get(task.id) }));
    return Object.freeze({
      ok: report.every((entry) => entry.status === 'completed'),
      tasks: Object.freeze(report),
      summary: Object.freeze({
        completed: report.filter((entry) => entry.status === 'completed').length,
        failed: report.filter((entry) => entry.status === 'failed').length,
        blocked: report.filter((entry) => entry.status === 'blocked').length,
      }),
    });
  }

  return Object.freeze({ run, REASONS: Object.freeze({ ...REASONS }) });
}

module.exports = { createMultiAgentCascadeGuard, REASONS };
