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
  EVALUATION_STATUS,
  EVALUATION_STOPPED,
  evaluateSemiNaive,
} = require('../lib/inference-semi-naive');

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

test('two-hop rule derives a previously unstored candidate fact', () => {
  const rule = createRule({
    id: 'rule:affects-through-type',
    head: atom('affects', [variable('X'), variable('Z')]),
    body: [
      atom('CAUSES', [variable('X'), variable('Y')]),
      atom('is_a', [variable('Y'), variable('Z')]),
    ],
  });

  const result = evaluateSemiNaive([rule], [
    fact('CAUSES', 'smoking', 'cancer'),
    fact('is_a', 'cancer', 'disease'),
  ], { timeoutMs: 10_000 });

  assert.equal(result.status, EVALUATION_STATUS.COMPLETE);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.FIXPOINT);
  assert.equal(result.derivedCandidates.length, 1);
  assert.deepEqual(result.derivedCandidates[0].fact, fact('affects', 'smoking', 'disease'));
  assert.equal(result.derivedCandidates[0].ruleId, 'rule:affects-through-type');
});

test('subsequent rounds are driven by delta facts, not the accumulated fact set', () => {
  const rules = [
    createRule({
      id: 'rule:stage-1',
      head: atom('stage_1', [variable('X')]),
      body: [atom('stage_0', [variable('X')])],
    }),
    createRule({
      id: 'rule:stage-2',
      head: atom('stage_2', [variable('X')]),
      body: [atom('stage_1', [variable('X')])],
    }),
  ];

  const result = evaluateSemiNaive(rules, [fact('stage_0', 'item')], {
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.COMPLETE);
  assert.deepEqual(result.stats.deltaFactCounts, [1, 1, 1]);
  assert.deepEqual(result.stats.factCountsByRoundStart, [1, 2, 3]);
  assert.equal(result.stats.driverFactVisits, 2);
  assert.ok(
    result.stats.driverFactVisits < result.stats.factCountsByRoundStart.reduce(
      (sum, count) => sum + (count * rules.length),
      0,
    ),
  );
});

test('cyclic rules terminate at a fixpoint by duplicate suppression', () => {
  const rules = [
    createRule({
      id: 'rule:p-to-q',
      head: atom('q', [variable('X')]),
      body: [atom('p', [variable('X')])],
    }),
    createRule({
      id: 'rule:q-to-p',
      head: atom('p', [variable('X')]),
      body: [atom('q', [variable('X')])],
    }),
  ];

  const result = evaluateSemiNaive(rules, [fact('p', 'a')], {
    maxRounds: 10,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.COMPLETE);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.FIXPOINT);
  assert.equal(result.rounds, 2);
  assert.deepEqual(
    result.derivedCandidates.map((candidate) => candidate.fact),
    [fact('q', 'a')],
  );
  assert.ok(result.stats.duplicateSuppressed >= 1);
});

test('round exhaustion reports stopped rather than pretending fixpoint', () => {
  const rules = [
    createRule({
      id: 'rule:one',
      head: atom('one', [variable('X')]),
      body: [atom('zero', [variable('X')])],
    }),
    createRule({
      id: 'rule:two',
      head: atom('two', [variable('X')]),
      body: [atom('one', [variable('X')])],
    }),
  ];

  const result = evaluateSemiNaive(rules, [fact('zero', 'a')], {
    maxRounds: 1,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.MAX_ROUNDS);
  assert.deepEqual(
    result.derivedCandidates.map((candidate) => candidate.fact),
    [fact('one', 'a')],
  );
});

test('work-budget exhaustion is explicit and preserves partial candidates as incomplete', () => {
  const rule = createRule({
    id: 'rule:work-budget',
    head: atom('q', [variable('X')]),
    body: [atom('p', [variable('X')])],
  });

  const result = evaluateSemiNaive([rule], [
    fact('p', 'a'),
    fact('p', 'b'),
  ], {
    maxOperations: 1,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.MAX_OPERATIONS);
  assert.equal(result.stats.operations, 1);
  assert.equal(result.derivedCandidates.length, 1);
});

test('time-budget exhaustion is explicit and testable with an injected clock', () => {
  let clock = 0;
  const now = () => {
    clock += 60;
    return clock;
  };
  const rule = createRule({
    id: 'rule:timeout',
    head: atom('q', [variable('X')]),
    body: [atom('p', [variable('X')])],
  });

  const result = evaluateSemiNaive([rule], [fact('p', 'a')], {
    timeoutMs: 100,
    now,
  });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.TIMEOUT);
  assert.equal(result.derivedCandidates.length, 0);
});

test('duplicate derivations are stable and keep the first deterministic rule', () => {
  const rules = [
    createRule({
      id: 'rule:z-second',
      head: atom('q', [variable('X')]),
      body: [atom('p', [variable('X')])],
    }),
    createRule({
      id: 'rule:a-first',
      head: atom('q', [variable('X')]),
      body: [atom('p', [variable('X')])],
    }),
  ];

  const first = evaluateSemiNaive(rules, [fact('p', 'a')], {
    timeoutMs: 10_000,
  });
  const second = evaluateSemiNaive([...rules].reverse(), [fact('p', 'a')], {
    timeoutMs: 10_000,
  });

  assert.deepEqual(first, second);
  assert.equal(first.derivedCandidates.length, 1);
  assert.equal(first.derivedCandidates[0].ruleId, 'rule:a-first');
  assert.ok(first.stats.duplicateSuppressed >= 1);
});

test('constraints fail closed when evidence cannot be evaluated', () => {
  const rule = createRule({
    id: 'rule:guarded',
    head: atom('eligible', [variable('X')]),
    body: [atom('member', [variable('X')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });

  const result = evaluateSemiNaive([rule], [fact('member', 'guest')], {
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.COMPLETE);
  assert.equal(result.derivedCandidates.length, 0);
  assert.equal(result.stats.constraintUnknowns, 1);
});

test('unsafe head variables fail closed instead of fabricating a constant', () => {
  const rule = createRule({
    id: 'rule:unsafe',
    head: atom('q', [variable('Y')]),
    body: [atom('p', [variable('X')])],
  });

  const result = evaluateSemiNaive([rule], [fact('p', 'a')], {
    timeoutMs: 10_000,
  });

  assert.equal(result.status, EVALUATION_STATUS.INVALID);
  assert.equal(result.stoppedReason, EVALUATION_STOPPED.UNSAFE_RULE);
  assert.equal(result.derivedCandidates.length, 0);
});

test('invalid budgets and non-ground facts fail closed as invalid input', () => {
  const rule = createRule({
    id: 'rule:invalid-input',
    head: atom('q', [variable('X')]),
    body: [atom('p', [variable('X')])],
  });

  const badBudget = evaluateSemiNaive([rule], [fact('p', 'a')], {
    maxRounds: 0,
  });
  assert.equal(badBudget.status, EVALUATION_STATUS.INVALID);
  assert.equal(badBudget.stoppedReason, EVALUATION_STOPPED.INVALID_INPUT);

  const badFact = evaluateSemiNaive([rule], [
    atom('p', [variable('X')]),
  ]);
  assert.equal(badFact.status, EVALUATION_STATUS.INVALID);
  assert.equal(badFact.stoppedReason, EVALUATION_STOPPED.INVALID_INPUT);
});
