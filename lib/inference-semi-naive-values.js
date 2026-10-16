'use strict';

const { atom, constant, serializeRule, parseRule } = require('./inference-rule-ir');

const EVALUATION_STATUS = Object.freeze({
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const EVALUATION_STOPPED = Object.freeze({
  FIXPOINT: 'fixpoint',
  MAX_OPERATIONS: 'max_operations',
  MAX_ROUNDS: 'max_rounds',
  MAX_DERIVED_FACTS: 'max_derived_facts',
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',
  UNSAFE_RULE: 'unsafe_rule',
});

const DEFAULT_MAX_OPERATIONS = 100_000;
const DEFAULT_MAX_ROUNDS = 64;
const DEFAULT_MAX_DERIVED_FACTS = 10_000;
const DEFAULT_TIMEOUT_MS = 100;

function normalizePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeLimits(opts = {}) {
  const maxOperations = normalizePositiveInteger(
    opts.maxOperations,
    DEFAULT_MAX_OPERATIONS,
  );
  const maxRounds = normalizePositiveInteger(opts.maxRounds, DEFAULT_MAX_ROUNDS);
  const maxDerivedFacts = normalizePositiveInteger(
    opts.maxDerivedFacts,
    DEFAULT_MAX_DERIVED_FACTS,
  );
  const timeoutMs = normalizeTimeout(opts.timeoutMs);
  if (
    maxOperations === null
    || maxRounds === null
    || maxDerivedFacts === null
    || timeoutMs === null
  ) {
    return null;
  }
  return { maxOperations, maxRounds, maxDerivedFacts, timeoutMs };
}

function factKey(fact) {
  return JSON.stringify([
    fact.predicate,
    ...fact.args.map((term) => term.value),
  ]);
}

function normalizeGroundFact(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.args)) {
    throw new TypeError('fact must contain predicate and args');
  }
  const args = input.args.map((term) => {
    if (!term || term.kind !== 'constant') {
      throw new TypeError('facts must contain only constant terms');
    }
    return constant(term.value);
  });
  return atom(input.predicate, args);
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

function normalizeFacts(input) {
  if (!Array.isArray(input)) throw new TypeError('facts must be an array');
  const byKey = new Map();
  for (const raw of input) {
    const fact = normalizeGroundFact(raw);
    byKey.set(factKey(fact), fact);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, fact]) => fact);
}

function unsafeHeadVariable(rule) {
  const bodyVariables = new Set();
  for (const bodyAtom of rule.body) {
    for (const term of bodyAtom.args) {
      if (term.kind === 'variable') bodyVariables.add(term.name);
    }
  }
  for (const term of rule.head.args) {
    if (term.kind === 'variable' && !bodyVariables.has(term.name)) return term.name;
  }
  return '';
}

function addFactToPredicateIndex(index, fact) {
  const list = index.get(fact.predicate) || [];
  list.push(fact);
  list.sort((left, right) => factKey(left).localeCompare(factKey(right)));
  index.set(fact.predicate, list);
}

function buildPredicateIndex(facts) {
  const index = new Map();
  for (const fact of facts) {
    const list = index.get(fact.predicate) || [];
    list.push(fact);
    index.set(fact.predicate, list);
  }
  for (const list of index.values()) {
    list.sort((left, right) => factKey(left).localeCompare(factKey(right)));
  }
  return index;
}

function bindingsMap(bindings) {
  return new Map(bindings.map((entry) => [entry.variable, entry.value]));
}

function instantiateAtom(pattern, bindings) {
  const map = bindingsMap(bindings);
  const args = pattern.args.map((term) => {
    if (term.kind === 'constant') return term;
    if (!map.has(term.name)) return null;
    return constant(map.get(term.name));
  });
  if (args.some((term) => term === null)) return null;
  return atom(pattern.predicate, args);
}

function freezeCandidate(candidate) {
  const supportByKey = new Map();
  for (const support of candidate.directSupports || []) {
    supportByKey.set(factKey(support), support);
  }
  const directSupports = [...supportByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, support]) => support);

  return Object.freeze({
    fact: candidate.fact,
    ruleId: candidate.ruleId,
    round: candidate.round,
    bindings: Object.freeze(
      candidate.bindings.map((entry) => Object.freeze({ ...entry })),
    ),
    directSupports: Object.freeze(directSupports),
  });
}

function emptyStats() {
  return {
    operations: 0,
    matchAttempts: 0,
    driverFactVisits: 0,
    duplicateSuppressed: 0,
    constraintUnknowns: 0,
    constraintRejections: 0,
    deltaFactCounts: [],
    factCountsByRoundStart: [],
  };
}

function emptyState() {
  return {
    round: 0,
    candidates: new Map(),
    stats: emptyStats(),
  };
}

function createState(limits, now) {
  return {
    ...emptyState(),
    ...limits,
    now,
    startedAt: now(),
  };
}

function freezeStats(stats) {
  return Object.freeze({
    operations: stats.operations,
    matchAttempts: stats.matchAttempts,
    driverFactVisits: stats.driverFactVisits,
    duplicateSuppressed: stats.duplicateSuppressed,
    constraintUnknowns: stats.constraintUnknowns,
    constraintRejections: stats.constraintRejections,
    deltaFactCounts: Object.freeze([...stats.deltaFactCounts]),
    factCountsByRoundStart: Object.freeze([...stats.factCountsByRoundStart]),
  });
}

function buildResult(state, status, stoppedReason, extra = {}) {
  return Object.freeze({
    status,
    stoppedReason,
    rounds: state.round,
    derivedCandidates: Object.freeze(
      [...state.candidates.values()]
        .sort((left, right) => factKey(left.fact).localeCompare(factKey(right.fact))),
    ),
    stats: freezeStats(state.stats),
    ...extra,
  });
}

function checkBudget(state) {
  if (state.stats.operations >= state.maxOperations) {
    return EVALUATION_STOPPED.MAX_OPERATIONS;
  }
  if (state.now() - state.startedAt > state.timeoutMs) {
    return EVALUATION_STOPPED.TIMEOUT;
  }
  return '';
}

function noteOperation(state) {
  const stoppedReason = checkBudget(state);
  if (stoppedReason) return stoppedReason;
  state.stats.operations += 1;
  return '';
}

module.exports = {
  EVALUATION_STATUS,
  EVALUATION_STOPPED,
  normalizeLimits,
  factKey,
  normalizeRules,
  normalizeFacts,
  unsafeHeadVariable,
  addFactToPredicateIndex,
  buildPredicateIndex,
  instantiateAtom,
  freezeCandidate,
  emptyState,
  createState,
  buildResult,
  checkBudget,
  noteOperation,
};
