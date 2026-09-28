'use strict';

const { atom, constant, serializeRule, parseRule } = require('./inference-rule-ir');
const { UNIFICATION_STATUS, unifyAtom } = require('./inference-unification');

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

function addFactToPredicateIndex(index, fact) {
  const list = index.get(fact.predicate) || [];
  list.push(fact);
  list.sort((left, right) => factKey(left).localeCompare(factKey(right)));
  index.set(fact.predicate, list);
}

function buildPredicateIndex(facts) {
  const index = new Map();
  for (const fact of facts) addFactToPredicateIndex(index, fact);
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

function candidateKey(candidate) {
  return factKey(candidate.fact);
}

function freezeCandidate(candidate) {
  return Object.freeze({
    fact: candidate.fact,
    ruleId: candidate.ruleId,
    round: candidate.round,
    bindings: Object.freeze(
      candidate.bindings.map((entry) => Object.freeze({ ...entry })),
    ),
  });
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
        .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right))),
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

function evaluateConstraints(rule, bindings, state, opts) {
  if (rule.constraints.length === 0) return { allowed: true, stoppedReason: '' };
  if (typeof opts.constraintEvaluator !== 'function') {
    state.stats.constraintUnknowns += 1;
    return { allowed: false, stoppedReason: '' };
  }

  for (const constraint of rule.constraints) {
    const stoppedReason = noteOperation(state);
    if (stoppedReason) return { allowed: false, stoppedReason };

    const ground = instantiateAtom(constraint, bindings);
    if (!ground) {
      state.stats.constraintUnknowns += 1;
      return { allowed: false, stoppedReason: '' };
    }

    let verdict;
    try {
      verdict = opts.constraintEvaluator(ground);
    } catch (_) {
      verdict = 'unknown';
    }

    if (verdict === false) {
      state.stats.constraintRejections += 1;
      return { allowed: false, stoppedReason: '' };
    }
    if (verdict !== true) {
      state.stats.constraintUnknowns += 1;
      return { allowed: false, stoppedReason: '' };
    }
  }

  return { allowed: true, stoppedReason: '' };
}

function joinRuleFromDeltaPosition(rule, driverIndex, deltaIndex, allIndex, state, opts) {
  const driverPattern = rule.body[driverIndex];
  const driverFacts = deltaIndex.get(driverPattern.predicate) || [];
  if (driverFacts.length === 0) return { candidates: [], stoppedReason: '' };

  const completed = [];

  for (const driverFact of driverFacts) {
    state.stats.driverFactVisits += 1;
    let stoppedReason = noteOperation(state);
    if (stoppedReason) return { candidates: completed, stoppedReason };

    state.stats.matchAttempts += 1;
    const driverMatch = unifyAtom(driverPattern, driverFact);
    if (driverMatch.status !== UNIFICATION_STATUS.MATCH) continue;

    let partials = [{
      bindings: driverMatch.bindings,
    }];

    for (let bodyIndex = 0; bodyIndex < rule.body.length; bodyIndex += 1) {
      if (bodyIndex === driverIndex) continue;
      const pattern = rule.body[bodyIndex];
      const factPool = allIndex.get(pattern.predicate) || [];
      const nextPartials = [];

      for (const partial of partials) {
        for (const fact of factPool) {
          stoppedReason = noteOperation(state);
          if (stoppedReason) {
            return { candidates: completed, stoppedReason };
          }

          state.stats.matchAttempts += 1;
          const match = unifyAtom(pattern, fact, { bindings: partial.bindings });
          if (match.status === UNIFICATION_STATUS.MATCH) {
            nextPartials.push({ bindings: match.bindings });
          }
        }
      }

      partials = nextPartials;
      if (partials.length === 0) break;
    }

    for (const partial of partials) {
      const constraint = evaluateConstraints(rule, partial.bindings, state, opts);
      if (constraint.stoppedReason) {
        return { candidates: completed, stoppedReason: constraint.stoppedReason };
      }
      if (!constraint.allowed) continue;

      const head = instantiateAtom(rule.head, partial.bindings);
      if (!head) {
        return {
          candidates: completed,
          stoppedReason: EVALUATION_STOPPED.UNSAFE_RULE,
        };
      }

      completed.push({
        fact: head,
        ruleId: rule.id,
        bindings: partial.bindings,
      });
    }
  }

  return { candidates: completed, stoppedReason: '' };
}

function evaluateSemiNaive(rulesInput, factsInput, opts = {}) {
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
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  const emptyState = {
    round: 0,
    candidates: new Map(),
    stats: {
      operations: 0,
      matchAttempts: 0,
      driverFactVisits: 0,
      duplicateSuppressed: 0,
      constraintUnknowns: 0,
      constraintRejections: 0,
      deltaFactCounts: [],
      factCountsByRoundStart: [],
    },
  };

  if (
    maxOperations === null
    || maxRounds === null
    || maxDerivedFacts === null
    || timeoutMs === null
  ) {
    return buildResult(
      emptyState,
      EVALUATION_STATUS.INVALID,
      EVALUATION_STOPPED.INVALID_INPUT,
    );
  }

  let rules;
  let facts;
  try {
    rules = normalizeRules(rulesInput);
    facts = normalizeFacts(factsInput);
  } catch (_) {
    return buildResult(
      emptyState,
      EVALUATION_STATUS.INVALID,
      EVALUATION_STOPPED.INVALID_INPUT,
    );
  }

  const state = {
    ...emptyState,
    maxOperations,
    maxRounds,
    maxDerivedFacts,
    timeoutMs,
    now,
    startedAt: now(),
  };

  const allFacts = new Map(facts.map((fact) => [factKey(fact), fact]));
  let allIndex = buildPredicateIndex(facts);
  let delta = facts;

  while (delta.length > 0) {
    if (state.round >= state.maxRounds) {
      return buildResult(
        state,
        EVALUATION_STATUS.STOPPED,
        EVALUATION_STOPPED.MAX_ROUNDS,
      );
    }

    const budgetStop = checkBudget(state);
    if (budgetStop) {
      return buildResult(state, EVALUATION_STATUS.STOPPED, budgetStop);
    }

    state.round += 1;
    state.stats.deltaFactCounts.push(delta.length);
    state.stats.factCountsByRoundStart.push(allFacts.size);

    const deltaIndex = buildPredicateIndex(delta);
    const nextDeltaMap = new Map();

    for (const rule of rules) {
      for (let driverIndex = 0; driverIndex < rule.body.length; driverIndex += 1) {
        const joined = joinRuleFromDeltaPosition(
          rule,
          driverIndex,
          deltaIndex,
          allIndex,
          state,
          opts,
        );

        for (const rawCandidate of joined.candidates) {
          const fact = rawCandidate.fact;
          const key = factKey(fact);
          if (allFacts.has(key) || nextDeltaMap.has(key)) {
            state.stats.duplicateSuppressed += 1;
            continue;
          }

          if (state.candidates.size >= state.maxDerivedFacts) {
            return buildResult(
              state,
              EVALUATION_STATUS.STOPPED,
              EVALUATION_STOPPED.MAX_DERIVED_FACTS,
            );
          }

          const candidate = freezeCandidate({
            ...rawCandidate,
            round: state.round,
          });
          nextDeltaMap.set(key, fact);
          state.candidates.set(key, candidate);
        }

        if (joined.stoppedReason) {
          const status = joined.stoppedReason === EVALUATION_STOPPED.UNSAFE_RULE
            ? EVALUATION_STATUS.INVALID
            : EVALUATION_STATUS.STOPPED;
          return buildResult(state, status, joined.stoppedReason);
        }
      }
    }

    if (nextDeltaMap.size === 0) {
      return buildResult(
        state,
        EVALUATION_STATUS.COMPLETE,
        EVALUATION_STOPPED.FIXPOINT,
      );
    }

    delta = [...nextDeltaMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, fact]) => fact);

    for (const fact of delta) {
      allFacts.set(factKey(fact), fact);
      addFactToPredicateIndex(allIndex, fact);
    }
  }

  return buildResult(
    state,
    EVALUATION_STATUS.COMPLETE,
    EVALUATION_STOPPED.FIXPOINT,
  );
}

module.exports = {
  EVALUATION_STATUS,
  EVALUATION_STOPPED,
  evaluateSemiNaive,
};
