'use strict';

const { atom, constant } = require('./inference-rule-ir');
const { UNIFICATION_STATUS, unifyAtom } = require('./inference-unification');
const {
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
} = require('./inference-backward-values');

function freezeTrace(trace) {
  if (!trace) return null;
  if (trace.kind === 'fact') {
    return Object.freeze({ kind: 'fact', fact: trace.fact });
  }
  return Object.freeze({
    kind: 'rule',
    ruleId: trace.ruleId,
    goal: trace.goal,
    bindings: trace.bindings,
    premises: Object.freeze(trace.premises.map(freezeTrace)),
  });
}

function publicResult(state, internal) {
  return Object.freeze({
    status: internal.status,
    reason: internal.reason,
    operations: state.operations,
    proof: freezeTrace(internal.trace),
  });
}

function stoppedFromBudget(reason) {
  return failure(BACKWARD_STATUS.STOPPED, reason);
}

function evaluateConstraintSet(rule, bindings, state, opts) {
  if (rule.constraints.length === 0) {
    return { status: BACKWARD_STATUS.PROVEN, reason: BACKWARD_REASON.RULE };
  }
  if (typeof opts.constraintEvaluator !== 'function') {
    return failure(BACKWARD_STATUS.UNKNOWN, BACKWARD_REASON.CONSTRAINT_UNKNOWN);
  }

  for (const constraint of rule.constraints) {
    const budget = noteOperation(state);
    if (budget) return stoppedFromBudget(budget);

    const ground = applyBindings(constraint, bindings);
    if (!isGround(ground)) {
      return failure(BACKWARD_STATUS.UNKNOWN, BACKWARD_REASON.CONSTRAINT_UNKNOWN);
    }

    let verdict;
    try {
      verdict = opts.constraintEvaluator(ground);
    } catch (_) {
      verdict = 'unknown';
    }
    if (verdict === false) {
      return failure(BACKWARD_STATUS.NOT_PROVEN, BACKWARD_REASON.CONSTRAINT_REJECTED);
    }
    if (verdict !== true) {
      return failure(BACKWARD_STATUS.UNKNOWN, BACKWARD_REASON.CONSTRAINT_UNKNOWN);
    }
  }

  return { status: BACKWARD_STATUS.PROVEN, reason: BACKWARD_REASON.RULE };
}

function solveSequence(goals, index, bindings, traces, depth, stack, ctx) {
  if (index >= goals.length) {
    return {
      status: BACKWARD_STATUS.PROVEN,
      reason: BACKWARD_REASON.RULE,
      bindings,
      traces,
    };
  }

  const enumerated = enumerateGoal(goals[index], bindings, depth, stack, ctx);
  const failures = [...enumerated.failures];

  for (const branch of enumerated.branches) {
    const next = solveSequence(
      goals,
      index + 1,
      branch.bindings,
      [...traces, branch.trace],
      depth,
      stack,
      ctx,
    );
    if (next.status === BACKWARD_STATUS.PROVEN) return next;
    failures.push(next);
    if (next.status === BACKWARD_STATUS.STOPPED) break;
  }

  return strongestFailure(failures);
}

function ruleBranch(rule, groundGoal, outerBindings, depth, stack, ctx) {
  const scopeId = ctx.state.scopeCounter;
  ctx.state.scopeCounter += 1;
  const fresh = freshenRule(rule, scopeId);

  const budget = noteOperation(ctx.state);
  if (budget) return stoppedFromBudget(budget);

  const headMatch = unifyAtom(fresh.rule.head, groundGoal);
  if (headMatch.status !== UNIFICATION_STATUS.MATCH) {
    return failure(BACKWARD_STATUS.NOT_PROVEN, BACKWARD_REASON.NO_PROOF);
  }

  const body = solveSequence(
    fresh.rule.body,
    0,
    headMatch.bindings,
    [],
    depth + 1,
    stack,
    ctx,
  );
  if (body.status !== BACKWARD_STATUS.PROVEN) return body;

  const constraint = evaluateConstraintSet(fresh.rule, body.bindings, ctx.state, ctx.opts);
  if (constraint.status !== BACKWARD_STATUS.PROVEN) return constraint;

  return {
    status: BACKWARD_STATUS.PROVEN,
    reason: BACKWARD_REASON.RULE,
    bindings: outerBindings,
    trace: {
      kind: 'rule',
      ruleId: rule.id,
      goal: groundGoal,
      bindings: originalRuleBindings(body.bindings, fresh.reverse),
      premises: body.traces,
    },
  };
}

function enumerateGoal(goalInput, bindings, depth, stack, ctx) {
  if (depth > ctx.state.maxDepth) {
    return {
      branches: [],
      failures: [failure(BACKWARD_STATUS.STOPPED, BACKWARD_REASON.MAX_DEPTH)],
    };
  }

  const budgetReason = checkBudget(ctx.state);
  if (budgetReason) {
    return { branches: [], failures: [stoppedFromBudget(budgetReason)] };
  }

  const goal = applyBindings(goalInput, bindings);
  const branches = [];
  const failures = [];
  const factPool = ctx.factIndex.get(goal.predicate) || [];

  for (const fact of factPool) {
    const budget = noteOperation(ctx.state);
    if (budget) {
      failures.push(stoppedFromBudget(budget));
      return { branches, failures };
    }

    const matched = unifyAtom(goal, fact, { bindings });
    if (matched.status === UNIFICATION_STATUS.MATCH) {
      branches.push({
        bindings: matched.bindings,
        trace: { kind: 'fact', fact },
      });
    }
  }

  if (!isGround(goal)) {
    const hasRule = ctx.rules.some((rule) => rule.head.predicate === goal.predicate);
    failures.push(failure(
      hasRule ? BACKWARD_STATUS.UNKNOWN : BACKWARD_STATUS.NOT_PROVEN,
      hasRule ? BACKWARD_REASON.NON_GROUND_RULE_GOAL : BACKWARD_REASON.NO_PROOF,
    ));
    return { branches, failures };
  }

  const key = atomKey(goal);
  if (stack.has(key)) {
    failures.push(failure(BACKWARD_STATUS.UNKNOWN, BACKWARD_REASON.CYCLE));
    return { branches, failures };
  }

  const nextStack = new Set(stack);
  nextStack.add(key);

  for (const rule of ctx.rules) {
    if (rule.head.predicate !== goal.predicate) continue;
    const branch = ruleBranch(rule, goal, bindings, depth, nextStack, ctx);
    if (branch.status === BACKWARD_STATUS.PROVEN) branches.push(branch);
    else failures.push(branch);
    if (branch.status === BACKWARD_STATUS.STOPPED) break;
  }

  if (branches.length === 0 && failures.length === 0) {
    failures.push(failure(BACKWARD_STATUS.NOT_PROVEN, BACKWARD_REASON.NO_PROOF));
  }
  return { branches, failures };
}

function proveBackward(queryInput, rulesInput, factsInput, opts = {}) {
  const limits = normalizeLimits(opts);
  if (!limits) {
    const state = { operations: 0 };
    return publicResult(
      state,
      failure(BACKWARD_STATUS.INVALID, BACKWARD_REASON.INVALID_INPUT),
    );
  }

  let query;
  let rules;
  let facts;
  try {
    query = normalizeGroundQuery(queryInput);
    rules = normalizeRules(rulesInput);
    facts = normalizeFacts(factsInput);
  } catch (_) {
    const state = { operations: 0 };
    return publicResult(
      state,
      failure(BACKWARD_STATUS.INVALID, BACKWARD_REASON.INVALID_INPUT),
    );
  }

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = createState(limits, now);
  const ctx = {
    state,
    opts,
    rules,
    factIndex: buildFactIndex(facts),
  };

  const enumerated = enumerateGoal(query, [], 0, new Set(), ctx);
  if (enumerated.branches.length > 0) {
    const branch = enumerated.branches[0];
    const reason = branch.trace.kind === 'fact' ? BACKWARD_REASON.FACT : BACKWARD_REASON.RULE;
    return publicResult(state, {
      status: BACKWARD_STATUS.PROVEN,
      reason,
      trace: branch.trace,
    });
  }

  return publicResult(state, strongestFailure(enumerated.failures));
}

module.exports = {
  BACKWARD_STATUS,
  BACKWARD_REASON,
  proveBackward,
};
