'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectGuardedFoldProgram, searchGuardedFoldPrograms } = require('../lib/experience/array-guarded-fold-program');
const { produceProject } = require('../lib/coder/project-producer');
const program = () => ({ type: 'guarded-fold', seed: 0, guard: { operator: '>', threshold: 0 },
  update: { type: 'binary', operator: '+', left: { type: 'acc' }, right: { type: 'integer', value: 1 } } });
const specOf = () => ({ kind: 'project_spec', name: 'guarded-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/count', compute: { family: 'array-guarded-fold', examples: [
    { input: [], expected: 0 }, { input: [-1, 0, -3], expected: 0 }, { input: [1, 2, -3], expected: 2 },
    { input: [3], expected: 1 }, { input: [0], expected: 0 },
  ], acceptanceExamples: [{ input: [-4, 3, 2, 0], expected: 2 }, { input: [8, -9], expected: 1 }, { input: [0, 0], expected: 0 }] } }] });
test('training infers conditional count with bounded search and never selects from acceptance', () => {
  const spec = specOf(); const produced = produceProject(spec);
  assert.equal(produced.ok, true, produced.reason);
  const route = produced.plan.computation.routes[0];
  assert.equal(route.enumerated, 6300); assert.equal(route.searchBudget, 6300);
  assert.equal(inspectGuardedFoldProgram(route.program).evaluate([-8, 0, 7, 9]), 2);
  assert.match(produced.task.operation.steps.find(step => step.path === 'src/logic.js').content, /if \(!\(item > 0\)\) continue/);
  spec.routes[0].compute.acceptanceExamples[0].expected = 999;
  const altered = produceProject(spec);
  assert.deepEqual(altered.plan.computation.routes[0].program, route.program);
  const warm = produceProject(spec, { candidatePrograms: [route.program] });
  assert.equal(warm.ok, true); assert.equal(warm.plan.computation.routes[0].enumerated, 0);
});
test('closed guards refuse executable data, extra operators, signed zero and malformed inputs', () => {
  let calls = 0;
  const getter = { get type() { calls += 1; return 'guarded-fold'; }, seed: 0, guard: program().guard, update: program().update };
  const proxy = new Proxy({}, { get() { calls += 1; }, ownKeys() { calls += 1; } });
  for (const value of [getter, proxy, { ...program(), guard: { operator: '|| evil()', threshold: 0 } },
    { ...program(), guard: { operator: '>', threshold: -0 } }, { ...program(), seed: -0 },
    { ...program(), update: { type: 'binary', operator: '+', left: program().update, right: { type: 'item' } } }])
    assert.equal(inspectGuardedFoldProgram(value).ok, false);
  const inspected = inspectGuardedFoldProgram(program());
  assert.ok(Object.isFrozen(inspected.program.guard));
  assert.equal(inspected.evaluate([-1000000, 1000000, 0]), 1);
  for (const input of [[-0], [1.5], [1000001], Array(129).fill(1), proxy, Object.defineProperty([], '0', { get() { calls += 1; return 1; } })])
    assert.throws(() => inspected.evaluate(input), /GUARDED_FOLD_INPUT_INVALID/);
  assert.equal(searchGuardedFoldPrograms({ get examples() { calls += 1; return []; } }).enumerated, 0);
  assert.equal(calls, 0);
  const product = inspectGuardedFoldProgram({ ...program(), seed: 1, update: { type: 'binary', operator: '*', left: { type: 'acc' }, right: { type: 'item' } } });
  assert.throws(() => product.evaluate([1000000, 1000000, 1000000]), /INTERMEDIATE_INVALID/);
  assert.equal(product.evaluate([-1000000, -1000000, -1000000]), 1);
});
test('warm selection separates guarded and ordinary families and keeps ambiguity closed', () => {
  const spec = specOf(); const inspected = inspectGuardedFoldProgram(program());
  assert.equal(produceProject(spec, { candidatePrograms: [{ type: 'fold', seed: 0, update: inspected.program.update }] }).reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  const equivalent = { ...program(), guard: { operator: '>=', threshold: 1 } };
  assert.equal(produceProject(spec, { candidatePrograms: [program(), equivalent] }).reason, 'PROJECT_COMPUTE_MEMORY_AMBIGUOUS');
  const invalid = specOf(); invalid.routes[0].compute.family = 'unknown';
  assert.equal(produceProject(invalid).ok, false);
});
