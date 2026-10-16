'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { produceProject, produceProjectRevision } = require('../lib/coder/project-producer');
const { searchStatefulFoldPrograms } = require('../lib/experience/array-stateful-fold-program');
const { searchMemoryScalarCompositions, inspectProjectProgram } = require('../lib/coder/project-programs');

function requirements() {
  const row = (input, expected) => ({ input, expected });
  const previous = { kind: 'project_spec', name: 'cost-api', archetype: 'node_computed_json_api', routes: [{
    path: '/measure', compute: { family: 'array-fold', examples: [row([], 0), row([1, 2], 3), row([-3, 5], 2)],
      acceptanceExamples: [row([8, 2], 10), row([-7, 3], -4), row([4], 4)] } }] };
  const next = structuredClone(previous); next.routes[0].compute = { family: 'array-stateful-fold',
    examples: [row([], 0), row([2, 5], 5), row([5, 2], 5), row([-4, -2], -2), row([-2, 7, 1], 7)],
    acceptanceExamples: [row([6, 9], 9), row([-8, -3], -3), row([22], 22)] };
  return { kind: 'project_revision', mode: 'update_routes', previous, next };
}

test('replay separates baseline proposals and accounts for any remaining baseline synthesis', () => {
  const spec = requirements();
  const before = produceProject(spec.previous), after = produceProject(spec.next);
  assert.equal(before.ok, true, before.reason); assert.equal(after.ok, true, after.reason);
  const options = { candidatePrograms: after.plan.computation.routes.map(route => route.program),
    baselineOptions: { candidatePrograms: before.plan.computation.routes.map(route => route.program) } };
  const cold = produceProjectRevision(spec), replayed = produceProjectRevision(spec, options);
  assert.equal(cold.ok, true, cold.reason); assert.equal(replayed.ok, true, replayed.reason);
  assert.ok(cold.plan.baselineSearch > 0);
  assert.equal(replayed.plan.baselineSearch, 0);
  assert.ok(replayed.plan.computation.routes.every(route => route.enumerated === 0));
  assert.deepEqual(replayed.task, cold.task);
  assert.equal(produceProjectRevision(spec, { candidatePrograms: options.candidatePrograms }).reason,
    'PROJECT_COMPUTE_MEMORY_NO_MATCH');
  const fallback = structuredClone(spec); fallback.previous.routes[0].compute.synthesizeOnMemoryMiss = true;
  const searched = produceProjectRevision(fallback, { ...options, baselineOptions: { candidatePrograms: options.candidatePrograms } });
  assert.equal(searched.ok, true, searched.reason);
  assert.ok(searched.plan.baselineSearch > 0);
  assert.equal(searched.plan.computation.routes[0].enumerated, 0);
});

test('new target training cannot contaminate the previous scalar holdout context', () => {
  const inputs = [[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]];
  const extremum = (input, minimum) => input.length ? (minimum ? Math.min(...input) : Math.max(...input)) : 0;
  const programs = [false, true].map(minimum => searchStatefulFoldPrograms({ examples: inputs.map(input => ({
    input, expected: extremum(input, minimum) })) }).candidates[0].program);
  const rows = values => values.map(input => ({ input, expected: extremum(input, false) - extremum(input, true) }));
  const examples = rows([[10, -5], [20, 3], [7, 8]]);
  const range = searchMemoryScalarCompositions({ candidatePrograms: programs, examples }).candidates[0].program;
  const canonical = inspectProjectProgram(range).canonicalExpression;
  const parent = { candidatePrograms: [...programs, range], methodContexts: [
    ...programs.map(program => ({ canonicalExpression: inspectProjectProgram(program).canonicalExpression, trainingInputs: inputs })),
    { canonicalExpression: canonical, trainingInputs: examples.map(row => row.input) }] };
  const previous = { kind: 'project_spec', name: 'context-api', archetype: 'node_computed_json_api', routes: [{
    path: '/range', composeScalar: { inferFromMemory: true, examples },
    acceptanceExamples: rows([[-100, -30], [42], [-1000000, 1000000]]) }] };
  const next = structuredClone(previous);
  next.routes[0].composeScalar.examples.push(...rows([[-100, -30]]));
  next.routes[0].acceptanceExamples = rows([[-50, -10], [41], [-5, 8]]);
  const target = { candidatePrograms: [range], methodContexts: [...parent.methodContexts,
    { canonicalExpression: canonical, trainingInputs: next.routes[0].composeScalar.examples.map(row => row.input) }] };
  const spec = { kind: 'project_revision', mode: 'update_routes', previous, next };
  assert.equal(produceProjectRevision(spec, target).reason, 'PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
  const isolated = produceProjectRevision(spec, { ...target, baselineOptions: parent });
  assert.equal(isolated.ok, true, isolated.reason);
  const leaked = structuredClone(spec); leaked.next.routes[0].acceptanceExamples = rows([[2, 5], [41], [-5, 8]]);
  assert.equal(produceProjectRevision(leaked, { ...target, baselineOptions: parent }).reason,
    'PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
});
