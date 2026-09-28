'use strict';

const { UNIFICATION_STATUS, unifyAtom } = require('./inference-unification');
const {
  EVALUATION_STOPPED,
  instantiateAtom,
  noteOperation,
} = require('./inference-semi-naive-values');

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

function joinRuleFromDeltaPosition(
  rule,
  driverIndex,
  deltaIndex,
  allIndex,
  state,
  opts,
) {
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

    let partials = [{ bindings: driverMatch.bindings }];

    for (let bodyIndex = 0; bodyIndex < rule.body.length; bodyIndex += 1) {
      if (bodyIndex === driverIndex) continue;
      const pattern = rule.body[bodyIndex];
      const factPool = allIndex.get(pattern.predicate) || [];
      const nextPartials = [];

      for (const partial of partials) {
        for (const fact of factPool) {
          stoppedReason = noteOperation(state);
          if (stoppedReason) return { candidates: completed, stoppedReason };

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

module.exports = { joinRuleFromDeltaPosition };
