'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectStatefulFoldProgram, searchStatefulFoldPrograms } = require('../lib/experience/array-stateful-fold-program');

for (const [name, direction] of [['maximum', -1], ['minimum', 1]]) {
  test(`synthesizes ${name} from training and passes independently sorted holdouts`, () => {
    const oracle = input => input.length ? [...input].sort((a, b) => direction * (a - b))[0] : 0;
    const examples = [[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]]
      .map(input => ({ input, expected: oracle(input) }));
    const found = searchStatefulFoldPrograms({ examples });
    assert.equal(found.enumerated, 48);
    assert.equal(found.candidates.length, 1);
    const method = inspectStatefulFoldProgram(found.candidates[0].program);
    assert.equal(method.ok, true);
    for (const input of [[], [-100, -30], [-30, -100], [7], [7, 7], [-1000000, 1000000],
      Array.from({ length: 128 }, (_, at) => at - 100)]) {
      assert.equal(method.evaluate(input), oracle(input));
    }
    const wrong = inspectStatefulFoldProgram({ ...method.program,
      guard: { operator: name === 'maximum' ? '<' : '>' } });
    assert.notEqual(wrong.evaluate([-100, -30]), oracle([-100, -30]));
    const wrongSeed = inspectStatefulFoldProgram({ ...method.program, seed: 'empty' });
    const seedWitness = name === 'maximum' ? [-100, -30] : [100, 30];
    assert.notEqual(wrongSeed.evaluate(seedWitness), oracle(seedWitness));
    const firstWitness = name === 'maximum' ? [80, -30] : [-80, 30];
    assert.notEqual(method.evaluate(firstWitness.slice(1)), oracle(firstWitness));
  });
}

test('rejects executable records and invalid runtime arrays without executing getters', () => {
  let touched = false;
  const hostile = { get examples() { touched = true; return []; } };
  assert.equal(searchStatefulFoldPrograms(hostile).candidates.length, 0);
  assert.equal(touched, false);
  const method = inspectStatefulFoldProgram({ type: 'stateful-fold', seed: 'first', emptyResult: 0,
    guard: { operator: '>' }, update: { type: 'item' } });
  for (const input of [Array(1), [-0], [Infinity], [1000001], Array(129).fill(1), new Proxy([], {})])
    assert.throws(() => method.evaluate(input));
  assert.equal(inspectStatefulFoldProgram(new Proxy({}, {})).ok, false);
});

test('evaluation remains bound to the immutable program after caller mutation', () => {
  const update = { type: 'item' };
  const data = { type: 'stateful-fold', seed: 'first', emptyResult: 0, guard: { operator: '>' }, update };
  const method = inspectStatefulFoldProgram(data);
  const identity = method.canonicalExpression;
  update.type = 'integer';
  update.value = 3;
  data.guard.operator = '<';
  data.emptyResult = 99;
  assert.equal(method.evaluate([1, 5]), 5);
  let touched = false;
  Object.defineProperty(update, 'type', { get() { touched = true; throw new Error('caller getter'); } });
  assert.equal(method.evaluate([1, 5]), 5);
  assert.equal(method.evaluate([]), 0);
  assert.equal(method.canonicalExpression, identity);
  assert.equal(touched, false);
});
