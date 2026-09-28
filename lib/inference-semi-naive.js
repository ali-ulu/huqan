'use strict';

const { isPlainObject } = require('./is-plain-object');
const {
  constant,
  atom,
  serializeRule,
  parseRule,
} = require('./inference-rule-ir');
const {
  UNIFICATION_STATUS,
  unifyAtom,
} = require('./inference-unification');

const EVALUATION_STATUS = Object.freeze({
  FIXPOINT: 'fixpoint',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const EVALUATION_REASON = Object.freeze({
  FIXPOINT_REACHED: 'fixpoint_reached',
  OPERATION_BUDGET_EXHAUSTED: 'operation_budget_exhausted',
  ROUND_BUDGET_EXHAUSTED: 'round_budget_exhausted',
  INVALID_OPTIONS: 'invalid_options',
  INVALID_FACT: 'invalid_fact',
  INVALID_RULE: 'invalid_rule',
  CONSTRAINT_UNKNOWN: 'constraint_unknown',
  CONSTRAINT_REJECTED: 'constraint_rejected',
  CONSTRAINT_INVALID: 'constraint_invalid',
});

const DEFAULT_MAX_ROUNDS = 32;
const DEFAULT_MAX_OPERATIONS = 10000;

function freezeArray(value) {
  return Object.freeze(value);
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function factKey(fact) {
  return JSON.stringify([
    fact.predicate,
    fact.args.map((term) => term.value),
  ]);
}

function compareFacts(left, right) {
  return factKey(left).localeCompare(factKey(right));
}

function compareRules(left, right) {
  return left.id.localeCompare(right.id);
}

function normalizeGroundFact(input) {
  if (!isPlainObject(input) || typeof input.predicate !== 'string' || !Array.isArray(input.args)) {
    throw new TypeError('fact must be an atom-shaped object');
  }
  const normalized = atom(
    input.predicate,
    input.args.map((term) => {
      if (!isPlainObject(term) || term.kind !== 'constant') {
        throw new TypeError('facts must be ground constants');
      }
      return constant(term.value);
    }),
  );
  return normalized;
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  const parsed = rules.map((rule) => parseRule(serializeRule(rule)));
  const seen = new Set();
  for (const rule of parsed) {
    if (seen.has(rule.id)) throw new TypeError(`duplicate rule id: ${rule.id}`);
    seen.add(rule.id);
  }
  return parsed.sort(compareRules);
}

function normalizeFacts(facts) {
  if (!Array.isArray(facts)) throw new TypeError('facts must be an array');
  const byKey = new Map();
  for (const fact of facts) {
    const normalized = normalizeGroundFact(fact);
    byKey.set(factKey(normalized), normalized);
  }
  return [...byKey.values()].sort(compareFacts);
}

function bindingsArrayToObject(bindings) {
  const out = Object.create(null);
  for (const binding of bindings) out[binding.variable] = binding.value;
  return out;
}

function bindingsObjectToArray(bindings) {
  return Object.freeze(
    Object.keys(bindings)
      .sort()
      .map((name) => Object.freeze({ variable: name, value: bindings[name] })),
  );
}

function instantiateAtom(template, bindings) {
  const args = [];
  for (const term of template.args) {
    if (term.kind === 'constant') {
      args.push(constant(term.value));
      continue;
    }
    if (!Object.hasOwn(bindings, term.name)) return null;
    args.push(constant(bindings[term.name]));
  }
  return atom(template.predicate, args);
}

function candidateKey(ruleId, fact) {
  return `${ruleId}\n${factKey(fact)}`;
}

function makeCandidate(rule, fact, supportFacts, round) {
  return Object.freeze({
    ruleId: rule.id,
    fact,
    supportFactKeys: freezeArray(
      supportFacts.map(factKey).sort(),
    ),
    round,
  });
}

function result(status, reason, state) {
  return Object.freeze({
    status,
    reason,
    rounds: state.rounds,
    operations: state.operations,
    seedFactCount: state.seedFactCount,
    totalFactCount: state.allFacts.size,
    candidates: freezeArray([...state.candidates.values()]),
    deltas: freezeArray(state.deltaHistory.map((delta) => freezeArray([...delta]))),
  });
}

function consumeOperation(state) {
  if (state.operations >= state.maxOperations) return false;
  state.operations += 1;
  return true;
}

function constraintVerdict(rule, bindings, opts, state) {
  if (!rule.constraints.length) return { ok: true };
  if (typeof opts.constraintEvaluator !== 'function') {
    return { ok: false, status: EVALUATION_STATUS.STOPPED, reason: EVALUATION_REASON.CONSTRAINT_UNKNOWN };
  }

  for (const constraint of rule.constraints) {
    if (!consumeOperation(state)) {
      return {
        ok: false,
        status: EVALUATION_STATUS.STOPPED,
        reason: EVALUATION_REASON.OPERATION_BUDGET_EXHAUSTED,
      };
    }
    const grounded = instantiateAtom(constraint, bindings);
    if (!grounded) {
      return { ok: false, status: EVALUATION_STATUS.STOPPED, reason: EVALUATION_REASON.CONSTRAINT_UNKNOWN };
    }

    let verdict;
    try {
      verdict = opts.constraintEvaluator(grounded);
    } catch (_) {
      return { ok: false, status: EVALUATION_STATUS.STOPPED, reason: EVALUATION_REASON.CONSTRAINT_UNKNOWN };
    }

    if (verdict === false) return { ok: false, skip: true, reason: EVALUATION_REASON.CONSTRAINT_REJECTED };
    if (verdict === 'unknown') {
      return { ok: false, status: EVALUATION_STATUS.STOPPED, reason: EVALUATION_REASON.CONSTRAINT_UNKNOWN };
    }
    if (verdict !== true) {
      return { ok: false, status: EVALUATION_STATUS.INVALID, reason: EVALUATION_REASON.CONSTRAINT_INVALID };
    }
  }
  return { ok: true };
}

function factPoolForPosition(rule, index, deltaPosition, allFacts, deltaFacts) {
  return index === deltaPosition ? deltaFacts : allFacts;
}

function joinRuleWithDelta(rule, allFacts, deltaFacts, state, opts, round) {
  const out = [];

  for (let deltaPosition = 0; deltaPosition < rule.body.length; deltaPosition += 1) {
    const search = [{
      bodyIndex: 0,
      bindings: Object.create(null),
      supports: [],
    }];

    while (search.length > 0) {
      const frame = search.pop();

      if (frame.bodyIndex >= rule.body.length) {
        const constraints = constraintVerdict(rule, frame.bindings, opts, state);
        if (!constraints.ok) {
          if (constraints.skip) continue;
          return { stop: true, status: constraints.status, reason: constraints.reason };
        }

        const derived = instantiateAtom(rule.head, frame.bindings);
        if (!derived) continue;
        out.push(makeCandidate(rule, derived, frame.supports, round));
        continue;
      }

      const bodyAtom = rule.body[frame.bodyIndex];
      const pool = factPoolForPosition(
        rule,
        frame.bodyIndex,
        deltaPosition,
        allFacts,
        deltaFacts,
      );

      for (let factIndex = pool.length - 1; factIndex >= 0; factIndex -= 1) {
        if (!consumeOperation(state)) {
          return {
            stop: true,
            status: EVALUATION_STATUS.STOPPED,
            reason: EVALUATION_REASON.OPERATION_BUDGET_EXHAUSTED,
          };
        }

        const match = unifyAtom(bodyAtom, pool[factIndex], {
          bindings: bindingsObjectToArray(frame.bindings),
          maxOperations: Math.max(0, state.maxOperations - state.operations),
        });

        state.operations += match.operations;

        if (state.operations > state.maxOperations) {
          return {
            stop: true,
            status: EVALUATION_STATUS.STOPPED,
            reason: EVALUATION_REASON.OPERATION_BUDGET_EXHAUSTED,
          };
        }

        if (match.status !== UNIFICATION_STATUS.MATCH) continue;

        search.push({
          bodyIndex: frame.bodyIndex + 1,
          bindings: bindingsArrayToObject(match.bindings),
          supports: [...frame.supports, pool[factIndex]],
        });
      }
    }
  }

  return { stop: false, candidates: out };
}

function evaluateSemiNaive(input = {}, opts = {}) {
  const maxRounds = normalizePositiveInteger(opts.maxRounds, DEFAULT_MAX_ROUNDS);
  const maxOperations = normalizePositiveInteger(opts.maxOperations, DEFAULT_MAX_OPERATIONS);
  if (maxRounds === null || maxOperations === null) {
    const emptyState = {
      rounds: 0,
      operations: 0,
      seedFactCount: 0,
      maxOperations: 0,
      allFacts: new Map(),
      candidates: new Map(),
      deltaHistory: [],
    };
    return result(EVALUATION_STATUS.INVALID, EVALUATION_REASON.INVALID_OPTIONS, emptyState);
  }

  let facts;
  let rules;
  try {
    facts = normalizeFacts(input.facts || []);
  } catch (_) {
    const emptyState = {
      rounds: 0,
      operations: 0,
      seedFactCount: 0,
      maxOperations,
      allFacts: new Map(),
      candidates: new Map(),
      deltaHistory: [],
    };
    return result(EVALUATION_STATUS.INVALID, EVALUATION_REASON.INVALID_FACT, emptyState);
  }
  try {
    rules = normalizeRules(input.rules || []);
  } catch (_) {
    const emptyState = {
      rounds: 0,
      operations: 0,
      seedFactCount: facts.length,
      maxOperations,
      allFacts: new Map(facts.map((fact) => [factKey(fact), fact])),
      candidates: new Map(),
      deltaHistory: [],
    };
    return result(EVALUATION_STATUS.INVALID, EVALUATION_REASON.INVALID_RULE, emptyState);
  }

  const state = {
    rounds: 0,
    operations: 0,
    seedFactCount: facts.length,
    maxOperations,
    allFacts: new Map(facts.map((fact) => [factKey(fact), fact])),
    candidates: new Map(),
    deltaHistory: [],
  };

  let deltaFacts = facts;

  while (deltaFacts.length > 0) {
    if (state.rounds >= maxRounds) {
      return result(
        EVALUATION_STATUS.STOPPED,
        EVALUATION_REASON.ROUND_BUDGET_EXHAUSTED,
        state,
      );
    }

    state.rounds += 1;
    state.deltaHistory.push(deltaFacts.map(factKey).sort());

    const allFacts = [...state.allFacts.values()].sort(compareFacts);
    const nextDelta = new Map();

    for (const rule of rules) {
      const joined = joinRuleWithDelta(
        rule,
        allFacts,
        deltaFacts,
        state,
        opts,
        state.rounds,
      );

      if (joined.stop) return result(joined.status, joined.reason, state);

      for (const candidate of joined.candidates.sort((left, right) => {
        const factCompare = compareFacts(left.fact, right.fact);
        return factCompare !== 0 ? factCompare : left.ruleId.localeCompare(right.ruleId);
      })) {
        const key = factKey(candidate.fact);
        if (state.allFacts.has(key) || nextDelta.has(key)) continue;

        const derivationKey = candidateKey(candidate.ruleId, candidate.fact);
        if (!state.candidates.has(derivationKey)) state.candidates.set(derivationKey, candidate);
        nextDelta.set(key, candidate.fact);
      }
    }

    if (nextDelta.size === 0) {
      return result(
        EVALUATION_STATUS.FIXPOINT,
        EVALUATION_REASON.FIXPOINT_REACHED,
        state,
      );
    }

    for (const [key, fact] of nextDelta) state.allFacts.set(key, fact);
    deltaFacts = [...nextDelta.values()].sort(compareFacts);
  }

  return result(
    EVALUATION_STATUS.FIXPOINT,
    EVALUATION_REASON.FIXPOINT_REACHED,
    state,
  );
}

module.exports = {
  EVALUATION_STATUS,
  EVALUATION_REASON,
  evaluateSemiNaive,
};
