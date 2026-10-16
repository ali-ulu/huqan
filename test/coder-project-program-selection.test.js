'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectArrayFoldProgram } = require('../lib/experience/array-fold-program');
const { produceComputedProject } = require('../lib/coder/project-compute');
const { produceProject } = require('../lib/coder/project-producer');
const { searchProjectPrograms } = require('../lib/coder/project-programs');
const leaf = type => ({ type });
const binary = (operator, left, right) => ({ type: 'binary', operator, left, right });
const sum = () => ({ type: 'fold', seed: 0, update: binary('+', leaf('acc'), leaf('item')) });
const specOf = () => ({ kind: 'project_spec', name: 'program-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/sum', compute: { family: 'array-fold', examples: [
    { input: [], expected: 0 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 7 },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: 5 }, { input: [1, 1, 1], expected: 3 }, { input: [20], expected: 20 },
  ] } }] });

test('omitted family selects map or filter from training alone and reports the portfolio cost', () => {
  const spec = specOf();
  delete spec.routes[0].compute.family;
  spec.routes[0].compute.examples = [
    { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [-3, 4], expected: [-6, 8] },
  ];
  spec.routes[0].compute.acceptanceExamples = [
    { input: [5], expected: [10] }, { input: [-2], expected: [-4] }, { input: [1, 3], expected: [2, 6] },
  ];
  const mapped = produceComputedProject(spec);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.computation.family, 'array-map');
  const selected = mapped.computation.routes[0];
  assert.equal(selected.family, 'array-map');
  assert.deepEqual(selected.familySearches.map(row => row.family), ['array-map', 'array-filter']);
  assert.equal(selected.enumerated, selected.familySearches.reduce((sum, row) => sum + row.enumerated, 0));
  assert.ok(selected.enumerated <= selected.searchBudget);
  const wrong = structuredClone(spec);
  wrong.routes[0].compute.acceptanceExamples[0].expected = [999];
  assert.deepEqual(produceComputedProject(wrong).computation, mapped.computation);
  assert.equal(produceProject(spec).ok, true);
  spec.routes[0].compute.examples = [
    { input: [], expected: [] }, { input: [-2, 0, 3], expected: [3] }, { input: [-1, 2], expected: [2] },
  ];
  assert.equal(produceComputedProject(spec).computation.family, 'array-filter');
});

test('family inference refuses cross-family ambiguity and does not use holdouts to break ties', () => {
  const spec = specOf(); delete spec.routes[0].compute.family;
  assert.equal(produceComputedProject(spec).reason, 'PROJECT_COMPUTE_FAMILY_AMBIGUOUS');
  spec.routes[0].compute.acceptanceExamples[0].expected = 999;
  assert.equal(produceComputedProject(spec).reason, 'PROJECT_COMPUTE_FAMILY_AMBIGUOUS');
});

test('inferred memory selection remains read-only, family-unique and opt-in on a cold miss', () => {
  const spec = specOf(); delete spec.routes[0].compute.family;
  const program = sum(); const frozen = JSON.stringify(program);
  const warm = produceComputedProject(spec, { candidatePrograms: [program] });
  assert.equal(warm.ok, true);
  assert.equal(warm.computation.family, 'array-fold');
  assert.equal(warm.computation.routes[0].enumerated, 0);
  assert.equal(JSON.stringify(program), frozen);
  assert.equal(produceComputedProject(spec, { candidatePrograms: [] }).reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  assert.equal(produceComputedProject(spec, { candidatePrograms: [{ type: 'pipeline', stages: [
    { type: 'map', expression: { type: 'item' } }, program,
  ] }] }).reason, 'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  spec.routes[0].compute.synthesizeOnMemoryMiss = true;
  assert.equal(produceComputedProject(spec, { candidatePrograms: [] }).reason, 'PROJECT_COMPUTE_FAMILY_AMBIGUOUS');
});

test('inference keeps all scalar family costs, no-solution and bounded-threshold refusal observable', () => {
  const result = searchProjectPrograms(undefined, [
    { input: [], expected: 2 }, { input: [4, 8], expected: 4 }, { input: [7, 3], expected: 3 },
  ]);
  assert.equal(result.family, 'array-stateful-fold');
  assert.equal(result.familySearches.length, 4);
  assert.equal(result.searchBudget, 71010);
  assert.equal(result.enumerated, result.familySearches.reduce((sum, row) => sum + row.enumerated, 0));
  const missing = searchProjectPrograms(undefined, [
    { input: [], expected: 2 }, { input: [4], expected: 999 }, { input: [7], expected: 999 },
  ]);
  assert.equal(missing.candidates.length, 0);
  assert.equal(missing.reason, undefined);
  const capped = searchProjectPrograms(undefined, [
    { input: [], expected: 0 }, { input: Array.from({ length: 30 }, (_, at) => at * 10), expected: 0 },
    { input: [999], expected: 0 },
  ]);
  assert.equal(capped.reason, 'PROJECT_COMPUTE_THRESHOLD_SEARCH_OVER_CAP');
  assert.ok(capped.enumerated <= capped.searchBudget);
  let invoked = false;
  const getter = []; Object.defineProperty(getter, '0', { enumerable: true, get() { invoked = true; return {}; } });
  assert.equal(searchProjectPrograms(undefined, getter).reason, 'PROJECT_COMPUTE_EXAMPLES_INVALID');
  assert.equal(invoked, false);
  const ambiguous = searchProjectPrograms(undefined, specOf().routes[0].compute.examples);
  assert.equal(ambiguous.reason, 'PROJECT_COMPUTE_FAMILY_AMBIGUOUS');
  assert.ok(ambiguous.matchingExpressions > 1);
  assert.equal(ambiguous.enumerated, ambiguous.familySearches.reduce((sum, row) => sum + row.enumerated, 0));
});

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
