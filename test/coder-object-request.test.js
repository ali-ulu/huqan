'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { produceProject } = require('../lib/coder/project-producer');
const row = (input, expected) => ({ input, expected });
const specOf = () => ({ kind: 'project_spec', name: 'object-api', archetype: 'node_computed_json_api', routes: [
  { path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([2], 2), row([3, 4], 7)],
    acceptanceExamples: [row([-3, 8], 5), row([1, 1, 1], 3), row([20], 20)] } },
] });
const filesOf = produced => Object.fromEntries(produced.task.operation.steps.filter(step => step.type === 'create_file').map(step => [step.path, step.content]));

test('object input binds a named request field without changing learned computation or acceptance', () => {
  const rawSpec = specOf(); const raw = produceProject(rawSpec);
  assert.equal(raw.ok, true, raw.reason);
  const objectSpec = specOf(); objectSpec.routes[0].inputField = 'values';
  const object = produceProject(objectSpec); assert.equal(object.ok, true, object.reason);
  assert.deepEqual(object.plan.computation, raw.plan.computation);
  assert.deepEqual(objectSpec.routes[0].compute, rawSpec.routes[0].compute);
  const files = filesOf(object);
  assert.deepEqual(JSON.parse(files['routes.json']), [{ path: '/sum', inputField: 'values' }]);
  assert.match(files['src/server.js'], /Object\.keys\(input\)\.length !== 1/);
  assert.match(files['test/api.test.js'], /\[route\.inputField\]: row\.input/);
  const warm = produceProject(objectSpec, { candidatePrograms: raw.plan.computation.routes.map(route => route.program) });
  assert.equal(warm.ok, true, warm.reason); assert.equal(warm.plan.computation.routes[0].enumerated, 0);
});

test('request field is closed data and rejects reserved, executable or oversized names', () => {
  for (const inputField of ['', '__proto__', 'constructor', 'prototype', 'a.b', 'x"; process.exit()', 'a'.repeat(33), 1, null]) {
    const spec = specOf(); spec.routes[0].inputField = inputField;
    assert.equal(produceProject(spec).reason, 'PROJECT_COMPUTE_ROUTE_INVALID');
  }
  let invoked = 0; const spec = specOf();
  Object.defineProperty(spec.routes[0], 'inputField', { enumerable: true, get() { invoked += 1; return 'values'; } });
  assert.equal(produceProject(spec).ok, false); assert.equal(invoked, 0);
});
