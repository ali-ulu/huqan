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
  EVALUATION_REASON,
  evaluateSemiNaive,
} = require('../lib/inference-semi-naive');

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

test('two-hop rule derives a previously unstored candidate fact', () => {
  const X = variable('X');
  const Y = variable('Y');
  const Z = variable('Z');

  const result = evaluateSemiNaive({
    facts: [
      fact('CAUSES', 'smoking', 'cancer'),
      fact('is_a', 'cancer', 'disease'),
    ],
    rules: [
      createRule({
        id: 'rule:affects-via-cause-type',
        head: atom('affects', [X, Z]),
        body: [
          atom('CAUSES', [X, Y]),
          atom('is_a', [Y, Z]),
        ],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.equal(result.reason, EVALUATION_REASON.FIXPOINT_REACHED);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].fact, fact('affects', 'smoking', 'disease'));
  assert.equal(result.candidates[0].ruleId, 'rule:affects-via-cause-type');
  assert.equal(result.candidates[0].round, 1);
});

test('subsequent rounds are driven by delta facts instead of treating all prior facts as new', () => {
  const X = variable('X');
  const Y = variable('Y');
  const Z = variable('Z');

  const result = evaluateSemiNaive({
    facts: [
      fact('parent_of', 'a', 'b'),
      fact('parent_of', 'b', 'c'),
    ],
    rules: [
      createRule({
        id: 'rule:ancestor-base',
        head: atom('ancestor_of', [X, Y]),
        body: [atom('parent_of', [X, Y])],
      }),
      createRule({
        id: 'rule:ancestor-step',
        head: atom('ancestor_of', [X, Z]),
        body: [
          atom('ancestor_of', [X, Y]),
          atom('parent_of', [Y, Z]),
        ],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.ok(result.deltas.length >= 2);
  assert.deepEqual(
    result.deltas[0],
    [
      JSON.stringify(['parent_of', ['a', 'b']]),
      JSON.stringify(['parent_of', ['b', 'c']]),
    ],
  );

  const secondRoundKeys = new Set(result.deltas[1]);
  assert.ok(secondRoundKeys.has(JSON.stringify(['ancestor_of', ['a', 'b']])));
  assert.ok(secondRoundKeys.has(JSON.stringify(['ancestor_of', ['b', 'c']])));
  assert.ok(!secondRoundKeys.has(JSON.stringify(['parent_of', ['a', 'b']])));
  assert.ok(!secondRoundKeys.has(JSON.stringify(['parent_of', ['b', 'c']])));

  assert.ok(
    result.candidates.some((candidate) =>
      candidate.fact.predicate === 'ancestor_of'
      && candidate.fact.args[0].value === 'a'
      && candidate.fact.args[1].value === 'c'),
  );
});

test('cyclic rules terminate at fixpoint with duplicate suppression', () => {
  const X = variable('X');
  const Y = variable('Y');

  const result = evaluateSemiNaive({
    facts: [fact('linked', 'a', 'b')],
    rules: [
      createRule({
        id: 'rule:forward',
        head: atom('reachable', [X, Y]),
        body: [atom('linked', [X, Y])],
      }),
      createRule({
        id: 'rule:cycle',
        head: atom('reachable', [X, Y]),
        body: [atom('reachable', [X, Y])],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].fact, fact('reachable', 'a', 'b'));
  assert.ok(result.rounds <= 2);
});

test('operation exhaustion reports stopped instead of pretending fixpoint', () => {
  const X = variable('X');
  const Y = variable('Y');

  const result = evaluateSemiNaive({
    facts: [
      fact('related_to', 'a', 'b'),
      fact('related_to', 'b', 'c'),
      fact('related_to', 'c', 'd'),
    ],
    rules: [
      createRule({
        id: 'rule:copy',
        head: atom('seen', [X, Y]),
        body: [atom('related_to', [X, Y])],
      }),
    ],
  }, { maxOperations: 1 });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.reason, EVALUATION_REASON.OPERATION_BUDGET_EXHAUSTED);
});

test('round exhaustion is explicit on a derivation chain', () => {
  const X = variable('X');

  const result = evaluateSemiNaive({
    facts: [fact('stage0', 'a')],
    rules: [
      createRule({
        id: 'rule:1',
        head: atom('stage1', [X]),
        body: [atom('stage0', [X])],
      }),
      createRule({
        id: 'rule:2',
        head: atom('stage2', [X]),
        body: [atom('stage1', [X])],
      }),
      createRule({
        id: 'rule:3',
        head: atom('stage3', [X]),
        body: [atom('stage2', [X])],
      }),
    ],
  }, { maxRounds: 1 });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.reason, EVALUATION_REASON.ROUND_BUDGET_EXHAUSTED);
  assert.ok(
    result.candidates.some((candidate) => candidate.fact.predicate === 'stage1'),
  );
});

test('duplicate rules for the same fact produce one new fact in the delta', () => {
  const X = variable('X');

  const result = evaluateSemiNaive({
    facts: [fact('is_a', 'cat', 'animal')],
    rules: [
      createRule({
        id: 'rule:a',
        head: atom('known', [X]),
        body: [atom('is_a', [X, constant('animal')])],
      }),
      createRule({
        id: 'rule:b',
        head: atom('known', [X]),
        body: [atom('is_a', [X, constant('animal')])],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.equal(
    result.deltas.flat().filter((key) => key === JSON.stringify(['known', ['cat']])).length,
    1,
  );
});

test('rule iteration is deterministic regardless of caller order', () => {
  const X = variable('X');
  const rules = [
    createRule({
      id: 'rule:z',
      head: atom('z_seen', [X]),
      body: [atom('input', [X])],
    }),
    createRule({
      id: 'rule:a',
      head: atom('a_seen', [X]),
      body: [atom('input', [X])],
    }),
  ];
  const input = { facts: [fact('input', 'x')] };

  const left = evaluateSemiNaive({ ...input, rules });
  const right = evaluateSemiNaive({ ...input, rules: [...rules].reverse() });

  assert.deepEqual(left.candidates, right.candidates);
  assert.deepEqual(left.deltas, right.deltas);
  assert.equal(left.operations, right.operations);
});

test('constraints are applied only after the rule body has bound their variables', () => {
  const X = variable('X');
  const Y = variable('Y');

  const result = evaluateSemiNaive({
    facts: [
      fact('related_to', 'alice', 'system'),
      fact('owns', 'alice', 'repo'),
    ],
    rules: [
      createRule({
        id: 'rule:trusted-owner',
        head: atom('may_operate', [X, Y]),
        body: [
          atom('related_to', [X, constant('system')]),
          atom('owns', [X, Y]),
        ],
        constraints: [
          atom('is_a', [X, constant('trusted_actor')]),
        ],
      }),
    ],
  }, {
    constraintEvaluator: (constraint) =>
      constraint.predicate === 'is_a'
      && constraint.args[0].value === 'alice'
      && constraint.args[1].value === 'trusted_actor',
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.deepEqual(result.candidates[0].fact, fact('may_operate', 'alice', 'repo'));
});

test('constraint unknown stops fail-closed instead of silently admitting a candidate', () => {
  const X = variable('X');

  const result = evaluateSemiNaive({
    facts: [fact('input', 'alice')],
    rules: [
      createRule({
        id: 'rule:guarded',
        head: atom('output', [X]),
        body: [atom('input', [X])],
        constraints: [atom('is_a', [X, constant('trusted_actor')])],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.STOPPED);
  assert.equal(result.reason, EVALUATION_REASON.CONSTRAINT_UNKNOWN);
  assert.equal(result.candidates.length, 0);
});

test('derived values are candidates only and do not mutate caller fact arrays', () => {
  const X = variable('X');
  const facts = [fact('input', 'a')];
  const snapshot = JSON.stringify(facts);

  const result = evaluateSemiNaive({
    facts,
    rules: [
      createRule({
        id: 'rule:copy',
        head: atom('output', [X]),
        body: [atom('input', [X])],
      }),
    ],
  });

  assert.equal(result.status, EVALUATION_STATUS.FIXPOINT);
  assert.equal(JSON.stringify(facts), snapshot);
  assert.equal(facts.length, 1);
});

test('invalid facts and duplicate rule ids fail closed deterministically', () => {
  const invalidFact = evaluateSemiNaive({
    facts: [atom('input', [variable('X')])],
    rules: [],
  });
  assert.equal(invalidFact.status, EVALUATION_STATUS.INVALID);
  assert.equal(invalidFact.reason, EVALUATION_REASON.INVALID_FACT);

  const X = variable('X');
  const duplicate = createRule({
    id: 'rule:duplicate',
    head: atom('output', [X]),
    body: [atom('input', [X])],
  });
  const duplicateRules = evaluateSemiNaive({
    facts: [fact('input', 'a')],
    rules: [duplicate, duplicate],
  });
  assert.equal(duplicateRules.status, EVALUATION_STATUS.INVALID);
  assert.equal(duplicateRules.reason, EVALUATION_REASON.INVALID_RULE);
});
