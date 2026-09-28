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
  BACKWARD_STATUS,
  BACKWARD_REASON,
  proveBackward,
} = require('../lib/inference-backward');

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

test('direct ground fact proves a query without fabricating a rule trace', () => {
  const result = proveBackward(
    fact('is_a', 'ali', 'human'),
    [],
    [fact('is_a', 'ali', 'human')],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.PROVEN);
  assert.equal(result.reason, BACKWARD_REASON.FACT);
  assert.equal(result.proof.kind, 'fact');
  assert.deepEqual(result.proof.fact, fact('is_a', 'ali', 'human'));
});

test('general rule proves a ground query from a supporting fact', () => {
  const rule = createRule({
    id: 'rule:mortal-human',
    head: atom('mortal', [variable('X')]),
    body: [atom('is_a', [variable('X'), constant('human')])],
  });

  const result = proveBackward(
    fact('mortal', 'ali'),
    [rule],
    [fact('is_a', 'ali', 'human')],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.PROVEN);
  assert.equal(result.reason, BACKWARD_REASON.RULE);
  assert.equal(result.proof.ruleId, 'rule:mortal-human');
  assert.deepEqual(result.proof.goal, fact('mortal', 'ali'));
  assert.deepEqual(result.proof.bindings, [{ variable: 'X', value: 'ali' }]);
  assert.equal(result.proof.premises.length, 1);
  assert.equal(result.proof.premises[0].kind, 'fact');
});

test('binding propagation across a two-goal body produces the correct proof', () => {
  const rule = createRule({
    id: 'rule:grandparent',
    head: atom('grandparent', [variable('X'), variable('Z')]),
    body: [
      atom('parent', [variable('X'), variable('Y')]),
      atom('parent', [variable('Y'), variable('Z')]),
    ],
  });

  const result = proveBackward(
    fact('grandparent', 'a', 'c'),
    [rule],
    [
      fact('parent', 'a', 'b'),
      fact('parent', 'b', 'c'),
      fact('parent', 'x', 'y'),
    ],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.PROVEN);
  assert.equal(result.proof.ruleId, 'rule:grandparent');
  assert.deepEqual(
    result.proof.premises.map((entry) => entry.fact),
    [fact('parent', 'a', 'b'), fact('parent', 'b', 'c')],
  );
  assert.deepEqual(result.proof.bindings, [
    { variable: 'X', value: 'a' },
    { variable: 'Y', value: 'b' },
    { variable: 'Z', value: 'c' },
  ]);
});

test('recursive rules prove without eager materialization and return nested rule ids', () => {
  const rules = [
    createRule({
      id: 'rule:ancestor-recursive',
      head: atom('ancestor', [variable('X'), variable('Z')]),
      body: [
        atom('parent', [variable('X'), variable('Y')]),
        atom('ancestor', [variable('Y'), variable('Z')]),
      ],
    }),
    createRule({
      id: 'rule:ancestor-base',
      head: atom('ancestor', [variable('X'), variable('Y')]),
      body: [atom('parent', [variable('X'), variable('Y')])],
    }),
  ];

  const result = proveBackward(
    fact('ancestor', 'a', 'c'),
    rules,
    [fact('parent', 'a', 'b'), fact('parent', 'b', 'c')],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.PROVEN);
  assert.equal(result.proof.ruleId, 'rule:ancestor-recursive');
  assert.equal(result.proof.premises[0].kind, 'fact');
  assert.equal(result.proof.premises[1].kind, 'rule');
  assert.equal(result.proof.premises[1].ruleId, 'rule:ancestor-base');
  assert.equal(result.proof.premises[1].premises[0].kind, 'fact');
});

test('failed proof is distinct from a budget-exhausted proof', () => {
  const missing = proveBackward(
    fact('mortal', 'nobody'),
    [],
    [],
    { timeoutMs: 10_000 },
  );
  assert.equal(missing.status, BACKWARD_STATUS.NOT_PROVEN);
  assert.equal(missing.reason, BACKWARD_REASON.NO_PROOF);

  const rule = createRule({
    id: 'rule:budget',
    head: atom('mortal', [variable('X')]),
    body: [atom('is_a', [variable('X'), constant('human')])],
  });
  const stopped = proveBackward(
    fact('mortal', 'ali'),
    [rule],
    [fact('is_a', 'ali', 'human')],
    { maxOperations: 1, timeoutMs: 10_000 },
  );
  assert.equal(stopped.status, BACKWARD_STATUS.STOPPED);
  assert.equal(stopped.reason, BACKWARD_REASON.MAX_OPERATIONS);
});

test('recursive cycle terminates as unknown instead of pretending no proof', () => {
  const rules = [
    createRule({
      id: 'rule:p-from-q',
      head: atom('p', [variable('X')]),
      body: [atom('q', [variable('X')])],
    }),
    createRule({
      id: 'rule:q-from-p',
      head: atom('q', [variable('X')]),
      body: [atom('p', [variable('X')])],
    }),
  ];

  const result = proveBackward(
    fact('p', 'a'),
    rules,
    [],
    { maxDepth: 20, timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.UNKNOWN);
  assert.equal(result.reason, BACKWARD_REASON.CYCLE);
});

test('depth exhaustion is explicit and different from cycle/failed proof', () => {
  const rule = createRule({
    id: 'rule:needs-body',
    head: atom('p', [variable('X')]),
    body: [atom('q', [variable('X')])],
  });

  const result = proveBackward(
    fact('p', 'a'),
    [rule],
    [fact('q', 'a')],
    { maxDepth: 0, timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.STOPPED);
  assert.equal(result.reason, BACKWARD_REASON.MAX_DEPTH);
});

test('missing constraint evidence stays unknown and never becomes proof confidence', () => {
  const rule = createRule({
    id: 'rule:guarded',
    head: atom('eligible', [variable('X')]),
    body: [atom('member', [variable('X')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });

  const result = proveBackward(
    fact('eligible', 'guest'),
    [rule],
    [fact('member', 'guest')],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.status, BACKWARD_STATUS.UNKNOWN);
  assert.equal(result.reason, BACKWARD_REASON.CONSTRAINT_UNKNOWN);
  assert.equal(result.proof, null);
});

test('same snapshot and rules reproduce the same proof regardless of input order', () => {
  const rules = [
    createRule({
      id: 'rule:z',
      head: atom('result', [variable('X')]),
      body: [atom('source_z', [variable('X')])],
    }),
    createRule({
      id: 'rule:a',
      head: atom('result', [variable('X')]),
      body: [atom('source_a', [variable('X')])],
    }),
  ];
  const facts = [fact('source_z', 'x'), fact('source_a', 'x')];

  const left = proveBackward(
    fact('result', 'x'),
    rules,
    facts,
    { timeoutMs: 10_000 },
  );
  const right = proveBackward(
    fact('result', 'x'),
    [...rules].reverse(),
    [...facts].reverse(),
    { timeoutMs: 10_000 },
  );

  assert.deepEqual(left, right);
  assert.equal(left.proof.ruleId, 'rule:a');
});

test('non-ground top-level queries fail closed as invalid input', () => {
  const result = proveBackward(
    atom('mortal', [variable('X')]),
    [],
    [],
  );

  assert.equal(result.status, BACKWARD_STATUS.INVALID);
  assert.equal(result.reason, BACKWARD_REASON.INVALID_INPUT);
});

test('time budget is explicit with an injected deterministic clock', () => {
  let clock = 0;
  const now = () => {
    clock += 60;
    return clock;
  };
  const rule = createRule({
    id: 'rule:timeout',
    head: atom('p', [variable('X')]),
    body: [atom('q', [variable('X')])],
  });

  const result = proveBackward(
    fact('p', 'a'),
    [rule],
    [fact('q', 'a')],
    { timeoutMs: 100, now },
  );

  assert.equal(result.status, BACKWARD_STATUS.STOPPED);
  assert.equal(result.reason, BACKWARD_REASON.TIMEOUT);
});
