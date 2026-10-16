'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectArrayFilterProgram, searchArrayFilterPrograms } = require('../lib/experience/array-filter-program');
const program = (operator = '>', threshold = 0) => ({ type: 'filter', guard: { operator, threshold } });
test('learns an ordered variable-length filter from training with bounded canonical search', () => {
  const search = searchArrayFilterPrograms({ examples: [
    { input: [], expected: [] }, { input: [-1, 0, 1], expected: [1] }, { input: [2, -2, 2], expected: [2, 2] },
  ] });
  assert.ok(search.enumerated > 0 && search.enumerated <= search.searchBudget && search.searchBudget <= 384);
  assert.equal(search.matchingExpressions, 1);
  const inspected = inspectArrayFilterProgram(search.candidates[0].program);
  assert.deepEqual(inspected.evaluate([-8, 3, 0, 7, 3]), [3, 7, 3]);
  assert.equal(inspectArrayFilterProgram(program('>', 0)).canonicalExpression,
    inspectArrayFilterProgram(program('>=', 1)).canonicalExpression);
  for (const boundary of [program('>', 1000000), program('<', -1000000)]) {
    const closed = inspectArrayFilterProgram(boundary);
    assert.equal(inspectArrayFilterProgram(closed.program).ok, true);
    assert.deepEqual(closed.evaluate([-1000000, 1000000]), []);
  }
  const threshold = searchArrayFilterPrograms({ examples: [
    { input: [], expected: [] }, { input: [-1, 49, 50], expected: [50] }, { input: [51, 48], expected: [51] },
  ] });
  assert.equal(threshold.matchingExpressions, 1);
  assert.deepEqual(inspectArrayFilterProgram(threshold.candidates[0].program).evaluate([-100, 49, 50, 80]), [50, 80]);
});
test('filter inspection and search never execute hostile properties or coerce predicates', () => {
  let calls = 0;
  const getter = program(); Object.defineProperty(getter, 'guard', { enumerable: true, get() { calls += 1; return {}; } });
  const proxy = new Proxy(program(), { get() { calls += 1; throw new Error('trap'); } });
  for (const value of [getter, proxy, program('eval'), program('>', -0), program('>', Infinity), { ...program(), extra: true }])
    assert.equal(inspectArrayFilterProgram(value).ok, false);
  const options = {}; Object.defineProperty(options, 'examples', { enumerable: true, get() { calls += 1; return []; } });
  assert.equal(searchArrayFilterPrograms(options).enumerated, 0);
  const inspected = inspectArrayFilterProgram(program());
  const arrayGetter = []; Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { calls += 1; return 1; } });
  for (const input of [arrayGetter, new Proxy([1], { get() { calls += 1; throw new Error('trap'); } }), Array(1), [-0], [1000001]])
    assert.throws(() => inspected.evaluate(input));
  assert.equal(calls, 0);
  const original = program(); const cloned = inspectArrayFilterProgram(original); original.guard.threshold = 8;
  assert.deepEqual(cloned.evaluate([1]), [1]); assert.equal(Object.isFrozen(cloned.program.guard), true);
});
test('filter search refuses reordered outputs and refuses oversized threshold domains before enumeration', () => {
  const search = searchArrayFilterPrograms({ examples: [
    { input: [], expected: [] }, { input: [1, 2], expected: [2, 1] }, { input: [3, 4], expected: [4, 3] },
  ] });
  assert.equal(search.candidates.length, 0);
  const capped = searchArrayFilterPrograms({ examples: [
    { input: [], expected: [] }, { input: Array.from({ length: 32 }, (_, at) => at * 10), expected: [] }, { input: [9], expected: [] },
  ] });
  assert.equal(capped.reason, 'PROJECT_COMPUTE_FILTER_SEARCH_OVER_CAP'); assert.equal(capped.enumerated, 0);
});
