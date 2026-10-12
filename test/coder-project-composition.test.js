'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { produceProject } = require('../lib/coder/project-producer');
const { inspectProjectProgram } = require('../lib/coder/project-programs');
const row = (input, expected) => ({ input, expected });
const specOf = () => ({ kind: 'project_spec', name: 'summary-api', archetype: 'node_computed_json_api', routes: [
  { path: '/summary', inputField: 'values', compose: { total: '/sum', positiveCount: '/count' }, acceptanceExamples: [
    row([4, -1, 3], { total: 6, positiveCount: 2 }), row([-2, -3], { total: -5, positiveCount: 0 }), row([10, 20], { total: 30, positiveCount: 2 }),
  ] },
  { path: '/count', compute: { family: 'array-guarded-fold', examples: [row([], 0), row([0], 0), row([1], 1), row([2, -3, 4], 2), row([2], 1), row([-2], 0)],
    acceptanceExamples: [row([3], 1), row([-1], 0), row([0, 5, 6], 2)] } },
  { path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([2], 2), row([3, 4], 7)],
    acceptanceExamples: [row([-3, 8], 5), row([1, 1, 1], 3), row([20], 20)] } },
] });

test('composes independently learned methods into a forward-referenced structured result', () => {
  const spec = specOf(); const cold = produceProject(spec);
  assert.equal(cold.ok, true, cold.reason);
  assert.equal(cold.plan.computation.routes.length, 2);
  for (const route of cold.plan.computation.routes) {
    const inspected = inspectProjectProgram(route.program);
    for (const example of spec.routes.find(entry => entry.path === route.path).compute.acceptanceExamples)
      assert.equal(inspected.evaluate(example.input), example.expected);
  }
  assert.deepEqual(cold.plan.computation.compositions, [{ path: '/summary', outputs: [{ name: 'total', path: '/sum' }, { name: 'positiveCount', path: '/count' }] }]);
  const logic = cold.task.operation.steps.find(step => step.path === 'src/logic.js').content;
  assert.match(logic, /"total": programs\[2\]\(input\)/);
  assert.match(logic, /"positiveCount": programs\[1\]\(input\)/);
  spec.routes[0].acceptanceExamples[0].expected.total = 999;
  assert.deepEqual(produceProject(spec).plan.computation, cold.plan.computation);
  const warm = produceProject(specOf(), { candidatePrograms: cold.plan.computation.routes.map(route => route.program) });
  assert.equal(warm.ok, true, warm.reason);
  assert.ok(warm.plan.computation.routes.every(route => route.enumerated === 0));
});

test('rejects composition cycles, unknown targets, malformed results and leaked training inputs', () => {
  const changes = [
    spec => { spec.routes[0].compose.total = '/summary'; },
    spec => { spec.routes[0].compose.total = '/missing'; },
    spec => { spec.routes[0].compose = { total: '/sum' }; },
    spec => { spec.routes[0].compose.constructor = '/sum'; },
    spec => { spec.routes[0].acceptanceExamples[0].expected.extra = 1; },
    spec => { delete spec.routes[0].acceptanceExamples[0].expected.total; },
    spec => { spec.routes[0].acceptanceExamples[0].input = [2]; },
    spec => { spec.routes[1].compute.examples[0] = null; },
    spec => { spec.routes[0].compute = spec.routes[1].compute; },
  ];
  for (const change of changes) {
    const spec = specOf(); change(spec);
    assert.equal(produceProject(spec).reason, 'PROJECT_COMPUTE_COMPOSITION_INVALID');
  }
});
