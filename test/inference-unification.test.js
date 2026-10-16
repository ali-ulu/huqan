'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  variable,
  constant,
  atom,
  createRule,
} = require('../lib/inference-rule-ir');
const {
  UNIFICATION_STATUS,
  UNIFICATION_REASON,
  unifyAtom,
  unifyRuleAtom,
} = require('../lib/inference-unification');

function ground(predicate, values) {
  return atom(predicate, values.map(constant));
}

test('ground CAUSES fact binds rule variables deterministically', () => {
  const result = unifyAtom(
    atom('CAUSES', [variable('X'), variable('Y')]),
    ground('CAUSES', ['smoking', 'cancer']),
  );

  assert.equal(result.status, UNIFICATION_STATUS.MATCH);
  assert.equal(result.reason, UNIFICATION_REASON.MATCHED);
  assert.deepEqual(result.bindings, [
    { variable: 'X', value: 'smoking' },
    { variable: 'Y', value: 'cancer' },
  ]);
  assert.equal(result.operations, 2);
});

test('binding output is sorted by variable name, not encounter order', () => {
  const result = unifyAtom(
    atom('related_to', [variable('Y'), variable('X')]),
    ground('related_to', ['second', 'first']),
  );

  assert.equal(result.status, UNIFICATION_STATUS.MATCH);
  assert.deepEqual(result.bindings, [
    { variable: 'X', value: 'first' },
    { variable: 'Y', value: 'second' },
  ]);
});

test('repeated variables cannot bind to two different constants', () => {
  const result = unifyAtom(
    atom('related_to', [variable('X'), variable('X')]),
    ground('related_to', ['a', 'b']),
  );

  assert.equal(result.status, UNIFICATION_STATUS.NO_MATCH);
  assert.equal(result.reason, UNIFICATION_REASON.REPEATED_VARIABLE_CONFLICT);
});

test('predicate and constant mismatches are distinct no-match outcomes', () => {
  const predicateMismatch = unifyAtom(
    atom('CAUSES', [variable('X'), variable('Y')]),
    ground('PREVENTS', ['a', 'b']),
  );
  assert.equal(predicateMismatch.status, UNIFICATION_STATUS.NO_MATCH);
  assert.equal(predicateMismatch.reason, UNIFICATION_REASON.PREDICATE_MISMATCH);

  const constantMismatch = unifyAtom(
    atom('is_a', [constant('cat'), variable('T')]),
    ground('is_a', ['dog', 'animal']),
  );
  assert.equal(constantMismatch.status, UNIFICATION_STATUS.NO_MATCH);
  assert.equal(constantMismatch.reason, UNIFICATION_REASON.CONSTANT_MISMATCH);
});

test('a type/is_a constraint can reject an otherwise syntactic match', () => {
  const rule = createRule({
    id: 'rule:type-guard',
    head: atom('eligible', [variable('X')]),
    body: [atom('related_to', [variable('X'), constant('system')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });

  const result = unifyRuleAtom(
    rule,
    0,
    ground('related_to', ['guest', 'system']),
    {
      constraintEvaluator: (constraint) => {
        assert.equal(constraint.predicate, 'is_a');
        assert.deepEqual(
          constraint.args.map((term) => term.value),
          ['guest', 'trusted_actor'],
        );
        return false;
      },
    },
  );

  assert.equal(result.status, UNIFICATION_STATUS.NO_MATCH);
  assert.equal(result.reason, UNIFICATION_REASON.CONSTRAINT_REJECTED);
});

test('constraints fail closed as unknown when no evaluator is supplied', () => {
  const rule = createRule({
    id: 'rule:needs-type-evidence',
    head: atom('eligible', [variable('X')]),
    body: [atom('related_to', [variable('X'), constant('system')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });

  const result = unifyRuleAtom(
    rule,
    0,
    ground('related_to', ['guest', 'system']),
  );

  assert.equal(result.status, UNIFICATION_STATUS.UNKNOWN);
  assert.equal(result.reason, UNIFICATION_REASON.CONSTRAINT_EVALUATOR_MISSING);
});

test('unresolved constraint variables produce unknown rather than a fabricated verdict', () => {
  const rule = createRule({
    id: 'rule:unresolved-constraint',
    head: atom('eligible', [variable('X')]),
    body: [atom('related_to', [variable('X'), constant('system')])],
    constraints: [atom('is_a', [variable('Z'), constant('trusted_actor')])],
  });

  const result = unifyRuleAtom(
    rule,
    0,
    ground('related_to', ['guest', 'system']),
    { constraintEvaluator: () => true },
  );

  assert.equal(result.status, UNIFICATION_STATUS.UNKNOWN);
  assert.equal(result.reason, UNIFICATION_REASON.CONSTRAINT_UNRESOLVED);
});

test('operation budget stops matching explicitly instead of returning no-match', () => {
  const result = unifyAtom(
    atom('related_to', [variable('X'), variable('Y')]),
    ground('related_to', ['a', 'b']),
    { maxOperations: 1 },
  );

  assert.equal(result.status, UNIFICATION_STATUS.STOPPED);
  assert.equal(result.reason, UNIFICATION_REASON.OPERATION_BUDGET_EXHAUSTED);
  assert.deepEqual(result.bindings, [{ variable: 'X', value: 'a' }]);
});

test('invalid rules are distinguishable from ordinary no-match', () => {
  const result = unifyRuleAtom(
    {
      schemaVersion: 'huqan.rule-ir.v1',
      id: '',
      head: {},
      body: [],
      constraints: [],
    },
    0,
    ground('related_to', ['a', 'b']),
  );

  assert.equal(result.status, UNIFICATION_STATUS.INVALID);
  assert.equal(result.reason, UNIFICATION_REASON.INVALID_RULE);
});

test('facts must be ground and cannot smuggle a second variable environment', () => {
  const result = unifyAtom(
    atom('is_a', [variable('X'), variable('T')]),
    atom('is_a', [variable('Y'), constant('animal')]),
  );

  assert.equal(result.status, UNIFICATION_STATUS.INVALID);
  assert.equal(result.reason, UNIFICATION_REASON.INVALID_FACT);
});

test('initial binding conflict is fail-closed and does not overwrite the caller binding', () => {
  const result = unifyAtom(
    atom('is_a', [variable('X'), variable('T')]),
    ground('is_a', ['cat', 'animal']),
    { bindings: [{ variable: 'X', value: 'dog' }] },
  );

  assert.equal(result.status, UNIFICATION_STATUS.NO_MATCH);
  assert.equal(result.reason, UNIFICATION_REASON.REPEATED_VARIABLE_CONFLICT);
  assert.deepEqual(result.bindings, [{ variable: 'X', value: 'dog' }]);
});

test('constraint evaluator errors and unknown verdicts remain explicit unknowns', () => {
  const rule = createRule({
    id: 'rule:constraint-errors',
    head: atom('eligible', [variable('X')]),
    body: [atom('related_to', [variable('X'), constant('system')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });
  const fact = ground('related_to', ['guest', 'system']);

  const thrown = unifyRuleAtom(rule, 0, fact, {
    constraintEvaluator: () => { throw new Error('lookup unavailable'); },
  });
  assert.equal(thrown.status, UNIFICATION_STATUS.UNKNOWN);
  assert.equal(thrown.reason, UNIFICATION_REASON.CONSTRAINT_EVALUATOR_ERROR);

  const unknown = unifyRuleAtom(rule, 0, fact, {
    constraintEvaluator: () => 'unknown',
  });
  assert.equal(unknown.status, UNIFICATION_STATUS.UNKNOWN);
  assert.equal(unknown.reason, UNIFICATION_REASON.CONSTRAINT_UNKNOWN);
});
