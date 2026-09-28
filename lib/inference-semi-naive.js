'use strict';

const {
  EVALUATION_STATUS,
  EVALUATION_STOPPED,
  normalizeLimits,
  factKey,
  normalizeRules,
  normalizeFacts,
  unsafeHeadVariable,
  addFactToPredicateIndex,
  buildPredicateIndex,
  freezeCandidate,
  emptyState,
  createState,
  buildResult,
  checkBudget,
} = require('./inference-semi-naive-values');
const { joinRuleFromDeltaPosition } = require('./inference-semi-naive-join');

function invalidResult(reason, extra = {}) {
  return buildResult(emptyState(), EVALUATION_STATUS.INVALID, reason, extra);
}

function evaluateSemiNaive(rulesInput, factsInput, opts = {}) {
  const limits = normalizeLimits(opts);
  if (!limits) return invalidResult(EVALUATION_STOPPED.INVALID_INPUT);

  let rules;
  let facts;
  try {
    rules = normalizeRules(rulesInput);
    facts = normalizeFacts(factsInput);
  } catch (_) {
    return invalidResult(EVALUATION_STOPPED.INVALID_INPUT);
  }

  const unsafe = rules
    .map((rule) => ({ rule, variable: unsafeHeadVariable(rule) }))
    .find((entry) => entry.variable);
  if (unsafe) {
    return invalidResult(
      EVALUATION_STOPPED.UNSAFE_RULE,
      { ruleId: unsafe.rule.id, variable: unsafe.variable },
    );
  }

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = createState(limits, now);
  const allFacts = new Map(facts.map((fact) => [factKey(fact), fact]));
  const allIndex = buildPredicateIndex(facts);
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
          const key = factKey(rawCandidate.fact);
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
          nextDeltaMap.set(key, rawCandidate.fact);
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
