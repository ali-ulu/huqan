'use strict';

const { isPlainObject } = require('./is-plain-object');
const {
  variable,
  constant,
  atom,
  serializeRule,
  parseRule,
} = require('./inference-rule-ir');

const UNIFICATION_STATUS = Object.freeze({
  MATCH: 'match',
  NO_MATCH: 'no_match',
  UNKNOWN: 'unknown',
  INVALID: 'invalid',
  STOPPED: 'stopped',
});

const UNIFICATION_REASON = Object.freeze({
  MATCHED: 'matched',
  PREDICATE_MISMATCH: 'predicate_mismatch',
  ARITY_MISMATCH: 'arity_mismatch',
  CONSTANT_MISMATCH: 'constant_mismatch',
  REPEATED_VARIABLE_CONFLICT: 'repeated_variable_conflict',
  INITIAL_BINDINGS_INVALID: 'initial_bindings_invalid',
  INVALID_PATTERN: 'invalid_pattern',
  INVALID_FACT: 'invalid_fact',
  INVALID_RULE: 'invalid_rule',
  INVALID_BODY_INDEX: 'invalid_body_index',
  CONSTRAINT_EVALUATOR_MISSING: 'constraint_evaluator_missing',
  CONSTRAINT_EVALUATOR_INVALID: 'constraint_evaluator_invalid',
  CONSTRAINT_EVALUATOR_ERROR: 'constraint_evaluator_error',
  CONSTRAINT_UNRESOLVED: 'constraint_unresolved',
  CONSTRAINT_REJECTED: 'constraint_rejected',
  CONSTRAINT_UNKNOWN: 'constraint_unknown',
  OPERATION_BUDGET_EXHAUSTED: 'operation_budget_exhausted',
  INVALID_OPTIONS: 'invalid_options',
});

const DEFAULT_MAX_OPERATIONS = 128;

function freezeBindings(bindings) {
  return Object.freeze(
    [...bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => Object.freeze({ variable: name, value })),
  );
}

function result(status, reason, bindings, operations, extra = {}) {
  return Object.freeze({
    status,
    reason,
    bindings: freezeBindings(bindings),
    operations,
    ...extra,
  });
}

function normalizeMaxOperations(value) {
  if (value === undefined) return DEFAULT_MAX_OPERATIONS;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizeTerm(input) {
  if (!isPlainObject(input)) throw new TypeError('term must be a plain object');
  if (input.kind === 'variable') return variable(input.name);
  if (input.kind === 'constant') return constant(input.value);
  throw new TypeError('term.kind must be variable or constant');
}

function normalizeAtom(input) {
  if (!isPlainObject(input) || !Array.isArray(input.args)) {
    throw new TypeError('atom must contain predicate and args');
  }
  return atom(input.predicate, input.args.map(normalizeTerm));
}

function normalizeGroundFact(input) {
  const normalized = normalizeAtom(input);
  if (normalized.args.some((term) => term.kind !== 'constant')) {
    throw new TypeError('fact atoms must be ground constants');
  }
  return normalized;
}

function normalizeInitialBindings(input) {
  const bindings = new Map();
  if (input === undefined) return bindings;
  if (!Array.isArray(input)) throw new TypeError('bindings must be an array');
  for (const entry of input) {
    if (
      !isPlainObject(entry)
      || typeof entry.variable !== 'string'
      || typeof entry.value !== 'string'
    ) {
      throw new TypeError('each binding must contain variable and value strings');
    }
    const name = variable(entry.variable).name;
    const value = constant(entry.value).value;
    if (bindings.has(name) && bindings.get(name) !== value) {
      throw new TypeError('initial bindings contain a conflicting variable');
    }
    bindings.set(name, value);
  }
  return bindings;
}

function resolveAtom(input, bindings) {
  const normalized = normalizeAtom(input);
  const args = [];
  for (const term of normalized.args) {
    if (term.kind === 'constant') {
      args.push(term);
      continue;
    }
    if (!bindings.has(term.name)) return null;
    args.push(constant(bindings.get(term.name)));
  }
  return atom(normalized.predicate, args);
}

function evaluateConstraints(constraints, bindings, state, opts) {
  if (!constraints.length) return null;
  if (typeof opts.constraintEvaluator !== 'function') {
    return result(
      UNIFICATION_STATUS.UNKNOWN,
      UNIFICATION_REASON.CONSTRAINT_EVALUATOR_MISSING,
      bindings,
      state.operations,
    );
  }

  for (const constraint of constraints) {
    if (state.operations >= state.maxOperations) {
      return result(
        UNIFICATION_STATUS.STOPPED,
        UNIFICATION_REASON.OPERATION_BUDGET_EXHAUSTED,
        bindings,
        state.operations,
      );
    }
    state.operations += 1;

    let ground;
    try {
      ground = resolveAtom(constraint, bindings);
    } catch (_) {
      return result(
        UNIFICATION_STATUS.INVALID,
        UNIFICATION_REASON.CONSTRAINT_EVALUATOR_INVALID,
        bindings,
        state.operations,
      );
    }
    if (!ground) {
      return result(
        UNIFICATION_STATUS.UNKNOWN,
        UNIFICATION_REASON.CONSTRAINT_UNRESOLVED,
        bindings,
        state.operations,
      );
    }

    let verdict;
    try {
      verdict = opts.constraintEvaluator(ground);
    } catch (_) {
      return result(
        UNIFICATION_STATUS.UNKNOWN,
        UNIFICATION_REASON.CONSTRAINT_EVALUATOR_ERROR,
        bindings,
        state.operations,
      );
    }

    if (verdict === false) {
      return result(
        UNIFICATION_STATUS.NO_MATCH,
        UNIFICATION_REASON.CONSTRAINT_REJECTED,
        bindings,
        state.operations,
      );
    }
    if (verdict === 'unknown') {
      return result(
        UNIFICATION_STATUS.UNKNOWN,
        UNIFICATION_REASON.CONSTRAINT_UNKNOWN,
        bindings,
        state.operations,
      );
    }
    if (verdict !== true) {
      return result(
        UNIFICATION_STATUS.INVALID,
        UNIFICATION_REASON.CONSTRAINT_EVALUATOR_INVALID,
        bindings,
        state.operations,
      );
    }
  }
  return null;
}

function unifyAtom(patternInput, factInput, opts = {}) {
  const maxOperations = normalizeMaxOperations(opts.maxOperations);
  if (maxOperations === null) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INVALID_OPTIONS,
      new Map(),
      0,
    );
  }

  let pattern;
  let fact;
  let bindings;
  try {
    pattern = normalizeAtom(patternInput);
  } catch (_) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INVALID_PATTERN,
      new Map(),
      0,
    );
  }
  try {
    fact = normalizeGroundFact(factInput);
  } catch (_) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INVALID_FACT,
      new Map(),
      0,
    );
  }
  try {
    bindings = normalizeInitialBindings(opts.bindings);
  } catch (_) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INITIAL_BINDINGS_INVALID,
      new Map(),
      0,
    );
  }

  if (pattern.predicate !== fact.predicate) {
    return result(
      UNIFICATION_STATUS.NO_MATCH,
      UNIFICATION_REASON.PREDICATE_MISMATCH,
      bindings,
      0,
    );
  }
  if (pattern.args.length !== fact.args.length) {
    return result(
      UNIFICATION_STATUS.NO_MATCH,
      UNIFICATION_REASON.ARITY_MISMATCH,
      bindings,
      0,
    );
  }

  const state = { operations: 0, maxOperations };

  for (let index = 0; index < pattern.args.length; index += 1) {
    if (state.operations >= state.maxOperations) {
      return result(
        UNIFICATION_STATUS.STOPPED,
        UNIFICATION_REASON.OPERATION_BUDGET_EXHAUSTED,
        bindings,
        state.operations,
      );
    }
    state.operations += 1;

    const patternTerm = pattern.args[index];
    const factValue = fact.args[index].value;

    if (patternTerm.kind === 'constant') {
      if (patternTerm.value !== factValue) {
        return result(
          UNIFICATION_STATUS.NO_MATCH,
          UNIFICATION_REASON.CONSTANT_MISMATCH,
          bindings,
          state.operations,
        );
      }
      continue;
    }

    if (bindings.has(patternTerm.name)) {
      if (bindings.get(patternTerm.name) !== factValue) {
        return result(
          UNIFICATION_STATUS.NO_MATCH,
          UNIFICATION_REASON.REPEATED_VARIABLE_CONFLICT,
          bindings,
          state.operations,
        );
      }
      continue;
    }
    bindings.set(patternTerm.name, factValue);
  }

  let constraints = [];
  if (opts.constraints !== undefined) {
    if (!Array.isArray(opts.constraints)) {
      return result(
        UNIFICATION_STATUS.INVALID,
        UNIFICATION_REASON.INVALID_OPTIONS,
        bindings,
        state.operations,
      );
    }
    constraints = opts.constraints;
  }

  const constraintResult = evaluateConstraints(constraints, bindings, state, opts);
  if (constraintResult) return constraintResult;

  return result(
    UNIFICATION_STATUS.MATCH,
    UNIFICATION_REASON.MATCHED,
    bindings,
    state.operations,
  );
}

function unifyRuleAtom(ruleInput, bodyIndex, factInput, opts = {}) {
  let rule;
  try {
    rule = parseRule(serializeRule(ruleInput));
  } catch (_) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INVALID_RULE,
      new Map(),
      0,
    );
  }

  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= rule.body.length) {
    return result(
      UNIFICATION_STATUS.INVALID,
      UNIFICATION_REASON.INVALID_BODY_INDEX,
      new Map(),
      0,
    );
  }

  return unifyAtom(rule.body[bodyIndex], factInput, {
    ...opts,
    constraints: rule.constraints,
  });
}

module.exports = {
  UNIFICATION_STATUS,
  UNIFICATION_REASON,
  unifyAtom,
  unifyRuleAtom,
};
