'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');
const { searchProjectPrograms, inspectProjectProgram } = require('../lib/coder/project-programs');
const { formatProjectTrainingQuestions } = require('../lib/cli-coder-project-memory');
const row = (input, expected) => ({ input, expected });
const specOf = () => ({ kind: 'project_spec', name: 'question-api', archetype: 'node_computed_json_api', routes: [
  { path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([1], 1), row([2], 2)],
    acceptanceExamples: [row([3], 3), row([4], 4), row([5], 5)] } },
] });

test('reports a bounded training-only disagreement witness without choosing a correct answer', () => {
  const spec = specOf(); const cold = produceProject(spec); assert.equal(cold.ok, true, cold.reason);
  const question = cold.plan.computation.routes[0].trainingQuestion;
  assert.ok(question.witness); assert.equal(question.exhaustive, false);
  assert.ok(question.checkedProbes <= question.probeLimit && question.candidateCount <= 8);
  assert.ok(new Set(question.witness.predictions.map(prediction => prediction.value)).size > 1);
  assert.ok(!spec.routes[0].compute.examples.some(example => JSON.stringify(example.input) === JSON.stringify(question.witness.input)));
  assert.equal(Object.hasOwn(question.witness, 'expected'), false);
  const search = searchProjectPrograms('array-fold', spec.routes[0].compute.examples);
  for (const prediction of question.witness.predictions)
    assert.equal(inspectProjectProgram(search.candidates[prediction.candidate - 1].program).evaluate(question.witness.input), prediction.value);
  assert.match(formatProjectTrainingQuestions(cold.plan), /Training question \(\/sum\).* -> \?/);
  spec.routes[0].compute.acceptanceExamples = [row([999999], 17), row([-777777], 19), row([123456], 23)];
  assert.deepEqual(produceProject(spec).plan.computation, cold.plan.computation);
});

test('no witness is not a uniqueness claim and sealed reuse performs no diagnostic enumeration', () => {
  const spec = specOf(); spec.routes[0].compute.examples.push(row([1, 2], 3), row([2, 3], 5));
  const cold = produceProject(spec); assert.equal(cold.ok, true, cold.reason);
  const question = cold.plan.computation.routes[0].trainingQuestion;
  assert.equal(question.exhaustive, false); assert.equal(question.witness, null);
  assert.equal(formatProjectTrainingQuestions(cold.plan), '');
  const warm = produceProject(spec, { candidatePrograms: [cold.plan.computation.routes[0].program] });
  assert.equal(warm.ok, true, warm.reason);
  assert.equal(warm.plan.computation.routes[0].enumerated, 0);
  assert.equal(Object.hasOwn(warm.plan.computation.routes[0], 'trainingQuestion'), false);
});

test('different declared answers to the same training question teach different programs', () => {
  const initial = produceProject(specOf());
  const { input } = initial.plan.computation.routes[0].trainingQuestion.witness;
  assert.ok(input.length > 1);
  const sumSpec = specOf(); sumSpec.routes[0].compute.examples.push(row(input, input.reduce((acc, item) => acc + item, 0)));
  const lastSpec = specOf(); lastSpec.routes[0].compute.examples.push(row(input, input.at(-1)));
  const sum = produceProject(sumSpec); const last = produceProject(lastSpec);
  assert.equal(sum.ok, true, sum.reason); assert.equal(last.ok, true, last.reason);
  const sumProgram = sum.plan.computation.routes[0].program; const lastProgram = last.plan.computation.routes[0].program;
  assert.notDeepEqual(sumProgram, lastProgram);
  assert.equal(inspectProjectProgram(sumProgram).evaluate([7, 8]), 15);
  assert.equal(inspectProjectProgram(lastProgram).evaluate([7, 8]), 8);
  assert.deepEqual(sumSpec.routes[0].compute.acceptanceExamples, lastSpec.routes[0].compute.acceptanceExamples);
});

test('native CLI dry-run exposes the training question in text and JSON without creating project files', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'training-question-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'target'); fs.mkdirSync(root);
  const specFile = path.join(base, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(specOf()));
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const run = extra => spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', specFile,
    '--root', root, '--dry-run', ...extra], { env, cwd: base, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const text = run([]); assert.equal(text.error, undefined, String(text.error)); assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Training question \(\/sum\).* -> \?/);
  const json = run(['--json']); assert.equal(json.error, undefined, String(json.error)); assert.equal(json.status, 0, json.stderr);
  assert.ok(JSON.parse(json.stdout).data.plan.computation.routes[0].trainingQuestion.witness);
  assert.deepEqual(fs.readdirSync(root), []);
});
