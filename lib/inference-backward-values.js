'use strict';

const {
  variable,
  constant,
  atom,
  createRule,
  serializeRule,
  parseRule,
} = require('./inference-rule-ir');

const BACKWARD_STATUS = Object.freeze({
  PROVEN: 'proven',
  NOT_PROVEN: 'not_proven',
  UNKNOWN: 'unknown',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const BACKWARD_REASON = Object.freeze({
  FACT: 'fact',
  RULE: 'rule',
  NO_PROOF: 'no_proof',
  CYCLE: 'cycle',
  NON_GROUND_RULE_GOAL: 'non_ground_rule_goal',
  CONSTRAINT_UNKNOWN: 'constraint_unknown',
  CONSTRAINT_REJECTED: 'constraint_rejected',
  MAX_OPERATIONS: 'max_operations',
  MAX_DEPTH: 'max_depth',
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',
});

const DEFAULT_MAX_OPERATIONS = 50_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 100;

function atomKey(input) {
  return JSON.stringify([
    input.predicate,
    ...input.args.map((term) => (
      term.kind === 'constant'
        ? ['c', term.value]
        : ['v', term.name]
    )),
  ]);
}

function groundFact(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.args)) {
    throw new TypeError('fact must contain predicate and args');
  }
  return atom(input.predicate, input.args.map((term) => {
    if (!term || term.kind !== 'constant') {
      throw new TypeError('facts must be ground');
    }
    return constant(term.value);
  }));
}

function normalizeFacts(input) {
  if (!Array.isArray(input)) throw new TypeError('facts must be an array');
  const byKey = new Map();
  for (const raw of input) {
    const fact = groundFact(raw);
    byKey.set(atomKey(fact), fact);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, fact]) => fact);
}

function normalizeRules(input) {
  if (!Array.isArray(input)) throw new TypeError('rules must be an array');
  return input
    .map((rule) => parseRule(serializeRule(rule)))
    .sort((left, right) => {
      const byId = left.id.localeCompare(right.id);
      if (byId !== 0) return byId;
      return serializeRule(left).localeCompare(serializeRule(right));
    });
}

function normalizeGroundQuery(input) {
  return groundFact(input);
}

function buildFactIndex(facts) {
  const index = new Map();
  for (const fact of facts) {
    const list = index.get(fact.predicate) || [];
    list.push(fact);
    index.set(fact.predicate, list);
  }
  for (const list of index.values()) {
    list.sort((left, right) => atomKey(left).localeCompare(atomKey(right)));
  }
  return index;
}

function bindingsMap(bindings) {
  return new Map(bindings.map((entry) => [entry.variable, entry.value]));
}

function applyBindings(input, bindings) {
  const map = bindingsMap(bindings);
  return atom(input.predicate, input.args.map((term) => {
    if (term.kind === 'constant') return term;
    return map.has(term.name) ? constant(map.get(term.name)) : variable(term.name);
  }));
}

function isGround(input) {
  return input.args.every((term) => term.kind === 'constant');
}

function freshenRule(rule, scopeId) {
  const names = new Map();
  const reverse = new Map();
  let next = 0;

  function freshTerm(term) {
    if (term.kind === 'constant') return term;
    if (!names.has(term.name)) {
      const fresh = `V${scopeId}_${next}`;
      next += 1;
      names.set(term.name, fresh);
      reverse.set(fresh, term.name);
    }
    return variable(names.get(term.name));
  }

  function freshAtom(input) {
    return atom(input.predicate, input.args.map(freshTerm));
  }

  return {
    rule: createRule({
      id: rule.id,
      head: freshAtom(rule.head),
      body: rule.body.map(freshAtom),
      constraints: rule.constraints.map(freshAtom),
    }),
    reverse,
  };
}

function originalRuleBindings(bindings, reverse) {
  return Object.freeze(
    bindings
      .filter((entry) => reverse.has(entry.variable))
      .map((entry) => ({
        variable: reverse.get(entry.variable),
        value: entry.value,
      }))
      .sort((left, right) => left.variable.localeCompare(right.variable))
      .map((entry) => Object.freeze(entry)),
  );
}

function normalizeLimits(opts = {}) {
  const maxOperations = opts.maxOperations === undefined
    ? DEFAULT_MAX_OPERATIONS
    : opts.maxOperations;
  const maxDepth = opts.maxDepth === undefined ? DEFAULT_MAX_DEPTH : opts.maxDepth;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;

  if (!Number.isInteger(maxOperations) || maxOperations <= 0) return null;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return { maxOperations, maxDepth, timeoutMs };
}

function createState(limits, now) {
  return {
    ...limits,
    now,
    startedAt: now(),
    operations: 0,
    scopeCounter: 0,
  };
}

function checkBudget(state) {
  if (state.operations >= state.maxOperations) return BACKWARD_REASON.MAX_OPERATIONS;
  if (state.now() - state.startedAt > state.timeoutMs) return BACKWARD_REASON.TIMEOUT;
  return '';
}

function noteOperation(state) {
  const reason = checkBudget(state);
  if (reason) return reason;
  state.operations += 1;
  return '';
}

function failure(status, reason) {
  return { status, reason, trace: null, bindings: null };
}

function failureRank(status) {
  if (status === BACKWARD_STATUS.STOPPED) return 3;
  if (status === BACKWARD_STATUS.UNKNOWN) return 2;
  if (status === BACKWARD_STATUS.NOT_PROVEN) return 1;
  return 0;
}

function strongestFailure(items) {
  let best = failure(BACKWARD_STATUS.NOT_PROVEN, BACKWARD_REASON.NO_PROOF);
  for (const item of items) {
    if (failureRank(item.status) > failureRank(best.status)) best = item;
  }
  return best;
}

module.exports = {
  BACKWARD_STATUS,
  BACKWARD_REASON,
  atomKey,
  normalizeFacts,
  normalizeRules,
  normalizeGroundQuery,
  buildFactIndex,
  applyBindings,
  isGround,
  freshenRule,
  originalRuleBindings,
  normalizeLimits,
  createState,
  checkBudget,
  noteOperation,
  failure,
  strongestFailure,
};
