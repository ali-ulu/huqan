'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { produceProject } = require('../lib/coder/project-producer');
const { inspectGuardedFoldProgram, inspectThresholdFoldProgram, searchThresholdFoldPrograms } = require('../lib/experience/array-guarded-fold-program');
const row = (input, expected) => ({ input, expected });
const specOf = () => ({ kind: 'project_spec', name: 'threshold-api', archetype: 'node_computed_json_api', routes: [
  { path: '/large', compute: { family: 'array-threshold-fold', examples: [row([], 0), row([1000], 0), row([1001], 1),
    row([1000, 1500, -1], 1), row([1000, 1001, 2000], 2)],
  acceptanceExamples: [row([1800], 1), row([999, 1000], 0), row([1000, 1001, 1200], 2)] } },
] });
test('synthesizes a training-derived threshold outside the fixed vocabulary without consulting acceptance', () => {
  const spec = specOf(); const cold = produceProject(spec);
  assert.equal(cold.ok, true, cold.reason);
  const selected = cold.plan.computation.routes[0];
  assert.equal(selected.program.type, 'threshold-fold');
  assert.deepEqual(selected.program.guard, { operator: '>', threshold: 1000 });
  assert.equal(selected.enumerated, selected.thresholdCount * 900);
  assert.equal(selected.enumerated, selected.searchBudget);
  assert.ok(selected.thresholdCount <= 64 && selected.searchBudget <= 57600);
  assert.equal(inspectThresholdFoldProgram(selected.program).evaluate([900, 2500, 1000, 1001]), 2);
  assert.match(cold.task.operation.steps.find(step => step.path === 'src/logic.js').content, /item > 1000/);
  spec.routes[0].compute.acceptanceExamples[0] = row([543210], 999);
  const altered = produceProject(spec);
  assert.deepEqual(altered.plan.computation.routes[0], selected);
  const warm = produceProject(spec, { candidatePrograms: [selected.program] });
  assert.equal(warm.ok, true); assert.equal(warm.plan.computation.routes[0].enumerated, 0);
});
test('threshold vocabulary overflow refuses explicitly without truncation or enumeration', () => {
  const examples = [row([], 0), row(Array.from({ length: 30 }, (_, at) => 10 * at + 100), 30), row([1], 0)];
  const search = searchThresholdFoldPrograms({ examples });
  assert.equal(search.reason, 'PROJECT_COMPUTE_THRESHOLD_SEARCH_OVER_CAP');
  assert.equal(search.enumerated, 0); assert.equal(search.candidates.length, 0);
  const spec = specOf(); spec.routes[0].compute.examples = examples;
  assert.equal(produceProject(spec).reason, search.reason);
});
test('wide threshold AST remains closed and cannot widen the old guarded family', () => {
  const program = { type: 'threshold-fold', seed: 0, guard: { operator: '>', threshold: 1000 },
    update: { type: 'binary', operator: '+', left: { type: 'acc' }, right: { type: 'integer', value: 1 } } };
  assert.equal(inspectGuardedFoldProgram(program).ok, false);
  assert.equal(inspectThresholdFoldProgram(program).ok, true);
  let executed = 0;
  const hostile = { ...program, guard: { get operator() { executed += 1; return '>'; }, threshold: 1000 } };
  for (const candidate of [hostile, { ...program, guard: { operator: '>', threshold: -0 } },
    { ...program, guard: { operator: '>', threshold: 1000001 } }, { ...program, guard: { operator: 'evil()', threshold: 1000 } }])
    assert.equal(inspectThresholdFoldProgram(candidate).ok, false);
  assert.equal(executed, 0);
});

test('learns negative and equality thresholds from boundary examples', () => {
  const cohorts = [
    { guard: { operator: '<', threshold: -450 }, examples: [row([], 0), row([-450], 0), row([-451], 1), row([2], 0), row([-1000], 1), row([-451, -1000], 2)],
      heldout: [row([-450, -451, -1000], 2), row([0, 1000], 0), row([-452], 1)] },
    { guard: { operator: '===', threshold: 1000 }, examples: [row([], 0), row([999], 0), row([1000], 1), row([1001], 0), row([-1], 0), row([1000, 1000], 2)],
      heldout: [row([1000, 2, 1000], 2), row([1000, 999], 1), row([1234, -1000], 0)] },
  ];
  for (const cohort of cohorts) {
    const spec = specOf(); spec.routes[0].compute.examples = cohort.examples;
    spec.routes[0].compute.acceptanceExamples = cohort.heldout;
    const produced = produceProject(spec); assert.equal(produced.ok, true, produced.reason);
    const program = produced.plan.computation.routes[0].program;
    assert.deepEqual(program.guard, cohort.guard);
    const inspected = inspectThresholdFoldProgram(program);
    for (const example of cohort.heldout) assert.equal(inspected.evaluate(example.input), example.expected);
  }
});
