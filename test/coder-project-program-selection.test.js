'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectArrayFoldProgram } = require('../lib/experience/array-fold-program');
const { produceComputedProject } = require('../lib/coder/project-compute');
const { produceProject } = require('../lib/coder/project-producer');
const leaf = type => ({ type });
const binary = (operator, left, right) => ({ type: 'binary', operator, left, right });
const sum = () => ({ type: 'fold', seed: 0, update: binary('+', leaf('acc'), leaf('item')) });
const specOf = () => ({ kind: 'project_spec', name: 'program-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/sum', compute: { family: 'array-fold', examples: [
    { input: [], expected: 0 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 7 },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: 5 }, { input: [1, 1, 1], expected: 3 }, { input: [20], expected: 20 },
  ] } }] });

test('cold enumerates while warm reuses exact program on a changed path and name without consulting holdouts', () => {
  const cold = produceComputedProject(specOf());
  assert.equal(cold.ok, true);
  assert.equal(cold.computation.routes[0].enumerated, 7062);
  const program = cold.computation.routes[0].program;
  const target = specOf(); target.name = 'renamed-api'; target.routes[0].path = '/renamed';
  target.routes[0].compute.acceptanceExamples[0].expected = 999;
  const warm = produceComputedProject(target, { candidatePrograms: [program, JSON.parse(JSON.stringify(program))] });
  assert.equal(warm.ok, true);
  assert.deepEqual(warm.computation.routes[0].program, program);
  assert.equal(warm.computation.routes[0].enumerated, 0);
  assert.equal(warm.computation.routes[0].searchBudget, 0);
  assert.equal(warm.computation.routes[0].source, 'memory');
  assert.equal(warm.files['src/logic.js'], cold.files['src/logic.js']);
  assert.match(warm.files['test/api.test.js'], /999/);
  assert.equal(produceProject(target, { candidatePrograms: [program] }).plan.computation.routes[0].enumerated, 0);
  const sourceWarm = produceProject(specOf(), { candidatePrograms: [program] });
  assert.deepEqual(sourceWarm.task.operation.steps, produceProject(specOf()).task.operation.steps);
});

test('warm path refuses ambiguity, no match and overflowing candidates without cold fallback', () => {
  const alternateSum = { type: 'fold', seed: 0, update: binary('+', leaf('item'), leaf('acc')) };
  assert.equal(produceComputedProject(specOf(), { candidatePrograms: [sum(), alternateSum] }).reason, 'PROJECT_COMPUTE_MEMORY_AMBIGUOUS');
  for (const candidatePrograms of [[], [{ type: 'fold', seed: 0, update: leaf('acc') }]])
    assert.equal(produceComputedProject(specOf(), { candidatePrograms }).reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  const product = { type: 'fold', seed: 1, update: binary('*', leaf('acc'), leaf('item')) };
  const spec = specOf(); spec.routes[0].compute.examples = [
    { input: [], expected: 1 }, { input: [2], expected: 2 }, { input: [1000000, 1000000, 1000000], expected: 1 },
  ];
  assert.equal(produceComputedProject(spec, { candidatePrograms: [product] }).reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
});

test('AST inspection clones bounded data and rejects hostile structures without executing properties', () => {
  const original = sum();
  const valid = inspectArrayFoldProgram(original);
  assert.equal(valid.ok, true);
  assert.notEqual(valid.program, original);
  assert.equal(valid.evaluate([2, 3]), 5);
  original.update.operator = '*';
  assert.equal(valid.evaluate([2, 3]), 5);
  let traps = 0;
  const getter = sum(); Object.defineProperty(getter, 'seed', { enumerable: true, get() { traps += 1; return 0; } });
  const proxy = new Proxy(sum(), { get() { traps += 1; return 'unsafe'; }, getPrototypeOf() { traps += 1; return Object.prototype; } });
  const proxyInput = new Proxy([1], { get() { traps += 1; return 1; } });
  assert.throws(() => valid.evaluate(proxyInput), /INPUT_INVALID/);
  const cycle = sum(); cycle.update.left = cycle.update;
  const tooDeep = sum(); tooDeep.update.left = binary('+', binary('+', leaf('acc'), leaf('item')), leaf('item'));
  for (const invalid of [getter, proxy, cycle, tooDeep, { ...sum(), extra: true },
    { ...sum(), seed: -0 }, { ...sum(), seed: 2 }, { ...sum(), update: { type: 'integer', value: -0 } },
    { ...sum(), update: { type: 'integer', value: 4 } }, { ...sum(), update: { type: 'item', extra: 1 } },
    { type: 'constant', value: 0 }]) {
    assert.equal(inspectArrayFoldProgram(invalid).ok, false);
    assert.equal(produceComputedProject(specOf(), { candidatePrograms: [invalid] }).reason, 'PROJECT_COMPUTE_MEMORY_INVALID');
  }
  assert.equal(traps, 0);
  assert.equal(produceComputedProject(specOf(), { candidatePrograms: Array(2) }).reason, 'PROJECT_COMPUTE_MEMORY_INVALID');
  assert.equal(produceComputedProject(specOf(), { candidatePrograms: Array(33).fill(sum()) }).reason, 'PROJECT_COMPUTE_MEMORY_INVALID');
});
