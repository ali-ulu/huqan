'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectArrayMapProgram, searchArrayMapPrograms } = require('../lib/experience/array-map-program');
const item = () => ({ type: 'item' });
const binary = (operator, left, right) => ({ type: 'binary', operator, left, right });
const square = () => ({ type: 'map', expression: binary('*', item(), item()) });

test('learns a length-preserving map from array observations with a finite search', () => {
  const search = searchArrayMapPrograms({ examples: [
    { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [9, 16] },
  ] });
  assert.equal(search.enumerated, 4105);
  assert.equal(search.searchBudget, 4105);
  assert.ok(search.candidates.length > 0 && search.candidates.length <= 8);
  const inspected = inspectArrayMapProgram(search.candidates[0].program);
  assert.deepEqual(inspected.evaluate([-3, 8]), [9, 64]);
  assert.deepEqual(inspected.evaluate([]), []);
  assert.deepEqual(inspected.program, square());
});

test('map programs reject accumulator dependencies and executable or unsupported AST data', () => {
  let calls = 0;
  const accessor = square(); Object.defineProperty(accessor, 'expression', { enumerable: true, get() { calls += 1; return item(); } });
  const proxy = new Proxy(square(), { get() { calls += 1; throw new Error('trap'); } });
  const cycle = square(); cycle.expression.left = cycle.expression;
  for (const invalid of [accessor, proxy, cycle, { ...square(), seed: 0 },
    { type: 'map', expression: { type: 'acc' } }, { type: 'map', expression: { type: 'integer', value: -0 } },
    { type: 'map', expression: binary('/', item(), item()) }]) assert.equal(inspectArrayMapProgram(invalid).ok, false);
  assert.equal(calls, 0);
  const options = {}; Object.defineProperty(options, 'examples', { enumerable: true, get() { calls += 1; return []; } });
  assert.equal(searchArrayMapPrograms(options).enumerated, 0);
  assert.equal(searchArrayMapPrograms(new Proxy({}, { get() { calls += 1; throw new Error('trap'); } })).enumerated, 0);
  assert.equal(calls, 0);
  const original = square(); const inspected = inspectArrayMapProgram(original);
  original.expression.operator = '+';
  assert.deepEqual(inspected.evaluate([3]), [9]);
});

test('map evaluation refuses unsafe inputs, signed zero outputs and intermediate overflow', () => {
  const inspected = inspectArrayMapProgram(square());
  let calls = 0;
  const accessor = []; Object.defineProperty(accessor, 0, { get() { calls += 1; return 2; } });
  const proxy = new Proxy([2], { get() { calls += 1; throw new Error('trap'); } });
  for (const input of [[-0], [1000001], [1.5], Array(2), accessor, proxy]) assert.throws(() => inspected.evaluate(input), /INPUT_INVALID/);
  assert.equal(calls, 0);
  const cube = inspectArrayMapProgram({ type: 'map', expression: binary('*', binary('*', item(), item()), item()) });
  assert.throws(() => cube.evaluate([1000000]), /INTERMEDIATE_INVALID/);
  const remainder = inspectArrayMapProgram({ type: 'map', expression: binary('%', item(), { type: 'integer', value: 2 }) });
  assert.throws(() => remainder.evaluate([-4]), /OUTPUT_INVALID/);
});
