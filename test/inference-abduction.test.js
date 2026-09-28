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
  ABDUCTION_STATUS,
  ABDUCTION_STOPPED,
  abduct,
} = require('../lib/inference-abduction');

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

test('controlled fixture returns the minimal explanation and drops a strict superset', () => {
  const rules = [
    createRule({
      id: 'rule:small',
      head: atom('wet', [variable('X')]),
      body: [atom('rain', [variable('X')])],
    }),
    createRule({
      id: 'rule:large',
      head: atom('wet', [variable('X')]),
      body: [
        atom('rain', [variable('X')]),
        atom('cloudy', [variable('X')]),
      ],
    }),
  ];

  const result = abduct(fact('wet', 'garden'), rules, [], {
    timeoutMs: 10_000,
  });

  assert.equal(result.status, ABDUCTION_STATUS.COMPLETE);
  assert.equal(result.stoppedReason, ABDUCTION_STOPPED.FIXPOINT);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].ruleId, 'rule:small');
  assert.deepEqual(
    result.candidates[0].missingPremises.map((item) => item.fact),
    [fact('rain', 'garden')],
  );
  assert.equal(result.candidates[0].state, 'provisional');
  assert.deepEqual(result.candidates[0].belief, {
    value: null,
    semantics: 'abduction_proposal_not_belief',
  });
  assert.equal(result.stats.dominatedCandidates, 1);
});

test('observed support keeps provenance separate from hypothetical premises', () => {
  const rule = createRule({
    id: 'rule:observed-plus-missing',
    head: atom('wet', [variable('X')]),
    body: [
      atom('sprinkler_on', [variable('X')]),
      atom('water_available', [variable('X')]),
    ],
  });

  const result = abduct(
    fact('wet', 'garden'),
    [rule],
    [{
      fact: fact('sprinkler_on', 'garden'),
      provenanceRefs: ['prov_sprinkler'],
      sourceRefs: ['sensor:sprinkler'],
    }],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.observedSupports, [{
    fact: fact('sprinkler_on', 'garden'),
    factKey: '["sprinkler_on","garden"]',
    provenanceRefs: ['prov_sprinkler'],
    sourceRefs: ['sensor:sprinkler'],
    hard: true,
  }]);
  assert.deepEqual(
    candidate.missingPremises.map((item) => item.fact),
    [fact('water_available', 'garden')],
  );
});

test('existing hard conflict defeats an otherwise valid explanation', () => {
  const rule = createRule({
    id: 'rule:rain',
    head: atom('wet', [variable('X')]),
    body: [atom('rain', [variable('X')])],
  });

  const result = abduct(fact('wet', 'garden'), [rule], [], {
    timeoutMs: 10_000,
    conflictEvaluator: (premise) => ({
      conflict: premise.predicate === 'rain',
      hard: true,
    }),
  });

  assert.equal(result.status, ABDUCTION_STATUS.COMPLETE);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.stats.conflictingPremisesRejected, 1);
});

test('soft conflict does not masquerade as hard evidence', () => {
  const rule = createRule({
    id: 'rule:soft',
    head: atom('wet', [variable('X')]),
    body: [atom('rain', [variable('X')])],
  });

  const result = abduct(fact('wet', 'garden'), [rule], [], {
    timeoutMs: 10_000,
    conflictEvaluator: () => ({ conflict: true, hard: false }),
  });

  assert.equal(result.candidates.length, 1);
});

test('budget exhaustion is explicit and never reported as complete search', () => {
  const rule = createRule({
    id: 'rule:budget',
    head: atom('wet', [variable('X')]),
    body: [atom('rain', [variable('X')])],
  });

  const result = abduct(fact('wet', 'garden'), [rule], [], {
    maxOperations: 1,
    timeoutMs: 10_000,
  });

  assert.equal(result.status, ABDUCTION_STATUS.STOPPED);
  assert.equal(result.stoppedReason, ABDUCTION_STOPPED.MAX_OPERATIONS);
  assert.equal(result.candidates.length, 0);
});

test('Dream co-occurrence seed remains explicitly non-semantic', () => {
  const rule = createRule({
    id: 'rule:dream-seed',
    head: atom('related', [variable('X'), variable('Y')]),
    body: [atom('similar', [variable('X'), variable('Y')])],
  });

  const result = abduct(fact('related', 'cat', 'keyboard'), [rule], [], {
    timeoutMs: 10_000,
    seedCandidates: [{
      fact: fact('similar', 'cat', 'keyboard'),
      source: 'dream',
      kind: 'co-occurrence-similarity',
      evidenceSemantics: 'semantic_embedding',
    }],
  });

  assert.equal(result.candidates.length, 1);
  const seed = result.candidates[0].missingPremises[0].seed;
  assert.equal(seed.source, 'dream');
  assert.equal(seed.kind, 'co-occurrence-similarity');
  assert.equal(seed.evidenceSemantics, 'co_occurrence_not_semantic');
  assert.equal(result.stats.dreamSeedsUsed, 1);
});

test('Dream seed may bind a missing variable but remains a hypothetical premise', () => {
  const rule = createRule({
    id: 'rule:seed-binding',
    head: atom('risk', [variable('X')]),
    body: [
      atom('CAUSES', [variable('X'), variable('Y')]),
      atom('is_a', [variable('Y'), constant('disease')]),
    ],
  });

  const result = abduct(fact('risk', 'smoking'), [rule], [], {
    timeoutMs: 10_000,
    seedCandidates: [{
      fact: fact('CAUSES', 'smoking', 'cancer'),
      source: 'dream',
      kind: 'transitive-gap',
    }],
  });

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    result.candidates[0].missingPremises.map((item) => item.fact),
    [
      fact('CAUSES', 'smoking', 'cancer'),
      fact('is_a', 'cancer', 'disease'),
    ],
  );
  assert.equal(result.candidates[0].observedSupports.length, 0);
});

test('same inputs reproduce candidate ordering regardless rule/evidence order', () => {
  const rules = [
    createRule({
      id: 'rule:z',
      head: atom('outcome', [variable('X')]),
      body: [atom('source_z', [variable('X')])],
    }),
    createRule({
      id: 'rule:a',
      head: atom('outcome', [variable('X')]),
      body: [atom('source_a', [variable('X')])],
    }),
  ];
  const evidence = [
    { fact: fact('source_z', 'x'), provenanceRefs: ['prov_z'] },
    { fact: fact('source_a', 'x'), provenanceRefs: ['prov_a'] },
  ];

  const left = abduct(fact('outcome', 'x'), rules, evidence, { timeoutMs: 10_000 });
  const right = abduct(
    fact('outcome', 'x'),
    [...rules].reverse(),
    [...evidence].reverse(),
    { timeoutMs: 10_000 },
  );

  assert.deepEqual(left, right);
  assert.deepEqual(left.candidates.map((candidate) => candidate.ruleId), [
    'rule:a',
    'rule:z',
  ]);
});

test('rule constraints fail closed when no evaluator is available', () => {
  const rule = createRule({
    id: 'rule:guarded',
    head: atom('eligible', [variable('X')]),
    body: [atom('member', [variable('X')])],
    constraints: [atom('is_a', [variable('X'), constant('trusted_actor')])],
  });

  const result = abduct(
    fact('eligible', 'guest'),
    [rule],
    [{ fact: fact('member', 'guest'), provenanceRefs: ['prov_member'] }],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.stats.constraintUnknowns, 1);
});

test('invalid observation/evidence or limits fail closed', () => {
  const invalidLimit = abduct(fact('wet', 'garden'), [], [], {
    maxCandidates: 0,
  });
  assert.equal(invalidLimit.status, ABDUCTION_STATUS.INVALID);
  assert.equal(invalidLimit.stoppedReason, ABDUCTION_STOPPED.INVALID_INPUT);

  const invalidEvidence = abduct(fact('wet', 'garden'), [], [{
    fact: fact('rain', 'garden'),
  }]);
  assert.equal(invalidEvidence.status, ABDUCTION_STATUS.INVALID);
});
