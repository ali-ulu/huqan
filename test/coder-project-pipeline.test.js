'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { produceProject } = require('../lib/coder/project-producer');
const { inspectProjectProgram } = require('../lib/coder/project-programs');
const rows = (inputs, fn) => inputs.map(input => ({ input, expected: fn(input) }));
const square = input => input.map(value => value * value);
const sum = input => input.reduce((acc, value) => acc + value, 0);
const fourth = input => sum(square(square(input)));
const specOf = () => ({ kind: 'project_spec', name: 'pipeline-api', archetype: 'node_computed_json_api', routes: [
  { path: '/fourth-total', pipeline: ['/square', '/square', '/sum'], acceptanceExamples: rows([[-3, 8], [5], [1, 2]], fourth) },
  { path: '/square', compute: { family: 'array-map', examples: rows([[], [2], [3, 4]], square), acceptanceExamples: rows([[-3, 8], [1, 1, 1], [20]], square) } },
  { path: '/sum', compute: { family: 'array-fold', examples: rows([[], [2], [3, 4]], sum), acceptanceExamples: rows([[-3, 8], [1, 1, 1], [20]], sum) } },
] });

test('rebuilds chain training lineage including transformed inputs and same-method aliases', () => {
  const { pipelineTrainingContexts, methodTrainingContexts } = require('../lib/coder/project-method-memory');
  const spec = specOf();
  spec.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [7], [2, 5]], fourth) };
  const alias = JSON.parse(JSON.stringify(spec.routes[1])); alias.path = '/square-alias';
  alias.compute.examples = rows([[], [9], [6, 8]], square); spec.routes.push(alias);
  const produced = produceProject(spec);
  assert.equal(produced.ok, true, JSON.stringify(produced));
  const contexts = pipelineTrainingContexts(spec, produced.plan.computation);
  const methods = methodTrainingContexts(spec, produced.plan.computation);
  const mapInputs = methods.find(method => method.canonicalExpression === contexts[0].stages[0].canonicalExpression).trainingInputs;
  assert.ok(mapInputs.some(input => JSON.stringify(input) === '[49]'));
  assert.ok(mapInputs.some(input => JSON.stringify(input) === '[9]'));
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].trainingInputs, [[], [7], [2, 5]]);
  assert.ok(contexts[0].stages[0].inputs.some(input => JSON.stringify(input) === '[9]'));
  assert.ok(contexts[0].stages[1].inputs.some(input => JSON.stringify(input) === '[49]'));
  assert.ok(contexts[0].stages[2].inputs.some(input => JSON.stringify(input) === '[2401]'));
  assert.ok(contexts[0].stages[2].inputs.some(input => JSON.stringify(input) === '[16,625]'));
  spec.routes[0].pipeline.examples[1].input[0] = 999;
  alias.compute.examples[1].input[0] = 999;
  assert.deepEqual(contexts[0].trainingInputs[1], [7]);
  assert.ok(mapInputs.some(input => JSON.stringify(input) === '[9]'));
  assert.ok(contexts[0].stages[0].inputs.some(input => JSON.stringify(input) === '[9]'));
  const declared = specOf(); const declaredPlan = produceProject(declared);
  assert.deepEqual(pipelineTrainingContexts(declared, declaredPlan.plan.computation)[0].trainingInputs, []);
});

test('reuses a sealed chain without base routes and rejects missing or overlapping source lineage', () => {
  const { pipelineTrainingContexts } = require('../lib/coder/project-method-memory');
  const source = specOf();
  source.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [6], [2, 3]], fourth) };
  const learned = produceProject(source); assert.equal(learned.ok, true, JSON.stringify(learned));
  const stages = learned.plan.computation.pipelines[0].stages.map(target =>
    learned.plan.computation.routes.find(route => route.path === target).program);
  const options = { candidatePrograms: [{ type: 'pipeline', stages }],
    pipelineContexts: pipelineTrainingContexts(source, learned.plan.computation) };
  const target = { kind: 'project_spec', name: 'direct-chain-api', archetype: 'node_computed_json_api', routes: [
    { path: '/answer', pipeline: { family: 'array-fold', reuseOnly: true, examples: rows([[], [7], [2, 5]], fourth) },
      acceptanceExamples: rows([[11, -2], [4, 7], [3, 5, 8]], fourth) },
  ] };
  const selected = produceProject(target, options); assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.deepEqual(selected.plan.computation.routes, []);
  assert.equal(selected.plan.computation.pipelines[0].enumerated, 0);
  const logic = selected.task.operation.steps.find(step => step.path === 'src/logic.js').content;
  const sandbox = { module: { exports: {} } }; require('node:vm').runInNewContext(logic, sandbox);
  assert.equal(sandbox.module.exports.compute(0, [11, -2]), 14657);
  assert.throws(() => sandbox.module.exports.compute(0, [1001]), /invalid_computation/);
  assert.equal(produceProject(target, { candidatePrograms: options.candidatePrograms }).reason, 'PROJECT_COMPUTE_PIPELINE_CONTEXT_MISSING');
  assert.equal(produceProject(target).reason, 'PROJECT_COMPUTE_PIPELINE_MEMORY_NO_MATCH');
  const aliasOptions = { ...options, candidatePrograms: [...options.candidatePrograms, JSON.parse(JSON.stringify(options.candidatePrograms[0]))] };
  assert.equal(produceProject(target, aliasOptions).plan.computation.pipelines[0].enumerated, 0);
  const ambiguous = JSON.parse(JSON.stringify(target));
  ambiguous.routes[0].pipeline.examples = rows([[], [0], [1]], fourth);
  const shorter = { type: 'pipeline', stages: [stages[0], stages[2]] };
  assert.equal(produceProject(ambiguous, { ...options, candidatePrograms: [...options.candidatePrograms, shorter] }).reason,
    'PROJECT_COMPUTE_PIPELINE_MEMORY_AMBIGUOUS');
  const sparse = JSON.parse(JSON.stringify(options)); delete sparse.pipelineContexts[0].stages[1];
  assert.equal(produceProject(target, sparse).reason, 'PROJECT_COMPUTE_PIPELINE_CONTEXT_MISSING');
  for (const input of [[6], [-2, 3], [4, 9]]) {
    const overlap = JSON.parse(JSON.stringify(target)); overlap.routes[0].acceptanceExamples[0] = { input, expected: fourth(input) };
    assert.equal(produceProject(overlap, options).reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  }
});

test('chains learned methods into a new bounded algorithm without selecting from acceptance', () => {
  const spec = specOf(); const cold = produceProject(spec);
  assert.equal(cold.ok, true, JSON.stringify(cold));
  const methods = cold.plan.computation.routes.map(route => route.program);
  const warm = produceProject(spec, { candidatePrograms: methods });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.ok(warm.plan.computation.routes.every(route => route.enumerated === 0));
  assert.deepEqual(warm.plan.computation.pipelines, [{ path: '/fourth-total', stages: ['/square', '/square', '/sum'] }]);
  spec.routes[0].acceptanceExamples[0].expected = 999;
  const wrong = produceProject(spec, { candidatePrograms: methods });
  assert.equal(wrong.ok, true, JSON.stringify(wrong));
  assert.equal(wrong.task.operation.steps.find(step => step.path === 'src/logic.js').content,
    warm.task.operation.steps.find(step => step.path === 'src/logic.js').content);
  const baseline = specOf(); baseline.routes = [{ path: '/fresh', compute: { family: 'array-fold',
    examples: rows([[], [2], [3, 4]], fourth), acceptanceExamples: rows([[-3, 8], [5], [1, 2]], fourth) } }];
  assert.equal(produceProject(baseline).reason, 'PROJECT_COMPUTE_NO_SOLUTION');
});

test('refuses malformed chains, scalar intermediate stages and training overlap after transformation', () => {
  const changes = [
    spec => { spec.routes[0].pipeline = ['/sum', '/square']; },
    spec => { spec.routes[0].pipeline = ['/missing', '/sum']; },
    spec => { spec.routes[0].pipeline = ['/fourth-total', '/sum']; },
    spec => { spec.routes[0].pipeline = ['/square']; },
    spec => { spec.routes[0].pipeline = Array(5).fill('/square'); },
    spec => { delete spec.routes[0].pipeline[1]; },
    spec => { spec.routes[0].compute = spec.routes[1].compute; },
    spec => { spec.routes[0].acceptanceExamples[0].expected = []; },
  ];
  for (const change of changes) { const spec = specOf(); change(spec); assert.equal(produceProject(spec).ok, false); }
  const transformed = specOf(); transformed.routes[0].pipeline = ['/square', '/sum'];
  transformed.routes[0].acceptanceExamples = rows([[-2], [5], [1, 2]], input => sum(square(input)));
  transformed.routes[2].compute.examples = rows([[], [4], [3, 4]], sum);
  assert.equal(produceProject(transformed).reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
});

test('infers the stage order from training alone and deduplicates identical method aliases', () => {
  const spec = specOf(); spec.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [2], [3, 4]], fourth) };
  const cold = produceProject(spec); assert.equal(cold.ok, true, JSON.stringify(cold));
  const methods = cold.plan.computation.routes.map(route => route.program);
  const chain = cold.plan.computation.pipelines[0];
  assert.deepEqual(chain.stages, ['/square', '/square', '/sum']);
  assert.equal(chain.source, 'training'); assert.equal(chain.enumerated, 3); assert.equal(chain.matchingChains, 1);
  assert.equal(chain.searchBudget, 2793);
  const warm = produceProject(spec, { candidatePrograms: methods });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.ok(warm.plan.computation.routes.every(route => route.enumerated === 0));
  assert.deepEqual(warm.plan.computation.pipelines, cold.plan.computation.pipelines);
  spec.routes[0].acceptanceExamples[0].expected = 999;
  const wrong = produceProject(spec, { candidatePrograms: methods });
  assert.equal(wrong.ok, true, JSON.stringify(wrong));
  assert.deepEqual(wrong.plan.computation.pipelines, [chain]);
  assert.equal(wrong.task.operation.steps.find(step => step.path === 'src/logic.js').content,
    warm.task.operation.steps.find(step => step.path === 'src/logic.js').content);
  const alias = JSON.parse(JSON.stringify(spec.routes[1])); alias.path = '/square-copy'; spec.routes.push(alias);
  const aliases = produceProject(spec, { candidatePrograms: methods }); assert.equal(aliases.ok, true, JSON.stringify(aliases));
  assert.equal(aliases.plan.computation.pipelines[0].enumerated, 3);
  assert.deepEqual(aliases.plan.computation.pipelines[0].stages, chain.stages);
});

test('inferred pipelines refuse ambiguity, no solution and training/acceptance overlap', () => {
  const ambiguous = specOf(); ambiguous.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [0], [1]], fourth) };
  assert.equal(produceProject(ambiguous).reason, 'PROJECT_COMPUTE_PIPELINE_AMBIGUOUS');
  const missing = specOf(); missing.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [2], [3, 4]], fourth) };
  missing.routes[0].pipeline.examples[1].expected = 999;
  assert.equal(produceProject(missing).reason, 'PROJECT_COMPUTE_PIPELINE_NO_SOLUTION');
  const overlap = specOf(); overlap.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [-3, 8], [3, 4]], fourth) };
  assert.equal(produceProject(overlap).reason, 'PROJECT_COMPUTE_PIPELINE_INVALID');
  const invalid = specOf(); invalid.routes[0].pipeline = { family: 'arbitrary-code', examples: rows([[], [2], [3, 4]], fourth) };
  assert.equal(produceProject(invalid).reason, 'PROJECT_COMPUTE_PIPELINE_INVALID');
});

test('closed chain ASTs are reused without order search and cannot contain nested or scalar intermediate programs', () => {
  const spec = specOf(); spec.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [2], [3, 4]], fourth) };
  const cold = produceProject(spec); assert.equal(cold.ok, true, JSON.stringify(cold));
  const methods = cold.plan.computation.routes.map(route => route.program);
  const chain = { type: 'pipeline', stages: [methods[0], methods[0], methods[1]] };
  const inspected = inspectProjectProgram(chain); assert.equal(inspected.ok, true);
  assert.equal(inspected.family, 'array-pipeline'); assert.equal(inspected.resultFamily, 'array-fold');
  assert.equal(inspected.evaluate([2, 3]), 97);
  const warm = produceProject(spec, { candidatePrograms: [...methods, chain] });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.equal(warm.plan.computation.pipelines[0].source, 'memory');
  assert.equal(warm.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(warm.plan.computation.pipelines[0].searchBudget, 0);
  for (const invalid of [{ type: 'pipeline', stages: [methods[1], methods[0]] },
    { type: 'pipeline', stages: [chain, methods[1]] }, { type: 'pipeline', stages: [methods[0]] },
    { type: 'pipeline', stages: Array(5).fill(methods[0]) }]) assert.equal(inspectProjectProgram(invalid).ok, false);
  assert.throws(() => inspected.evaluate([1001]));
  chain.stages[0] = methods[1]; assert.equal(inspected.evaluate([2, 3]), 97);
});

test('remembered chains deduplicate exact aliases but refuse distinct matching orders', () => {
  const spec = specOf(); spec.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [0], [1]], fourth) };
  const source = specOf(); source.routes.shift(); const produced = produceProject(source);
  const methods = produced.plan.computation.routes.map(route => route.program);
  const squareSum = { type: 'pipeline', stages: [methods[0], methods[1]] };
  const fourthSum = { type: 'pipeline', stages: [methods[0], methods[0], methods[1]] };
  const duplicate = produceProject(spec, { candidatePrograms: [...methods, fourthSum, JSON.parse(JSON.stringify(fourthSum))] });
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(produceProject(spec, { candidatePrograms: [...methods, squareSum, fourthSum] }).reason, 'PROJECT_COMPUTE_PIPELINE_MEMORY_AMBIGUOUS');
});

test('generated HTTP chains preserve array results and refuse oversized intermediate stage inputs', async t => {
  const spec = specOf(); spec.routes[0].pipeline = ['/square', '/square'];
  spec.routes[0].acceptanceExamples = rows([[-3, 8], [5], [1, 2]], input => square(square(input)));
  const produced = produceProject(spec); assert.equal(produced.ok, true, JSON.stringify(produced));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const step of produced.task.operation.steps) {
    const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
  }
  const server = require(path.join(root, 'src/server.js')).createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = values => fetch('http://127.0.0.1:' + server.address().port + '/fourth-total', { method: 'POST', body: JSON.stringify(values) });
  const good = await post([2, 3]); assert.equal(good.status, 200); assert.deepEqual(await good.json(), { result: [16, 81] });
  const overflow = await post([1001]); assert.equal(overflow.status, 422);
  assert.deepEqual(await overflow.json(), { error: 'invalid_computation' });
});

test('native sealed reuse infers a fourth-power service and rolls back incorrect independent acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-pipeline-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/pipeline-fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const memory = path.join(base, 'method.json'); let sequence = 0;
  const run = (spec, memoryFile = memory) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const file = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', file,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', path.join(base, 'journal.db'),
      ...[].concat(memoryFile).flatMap(file => ['--project-memory', file]), '--run-id', `pipeline-${sequence}`, '--json'], { cwd: base, encoding: 'utf8',
      timeout: 120000, windowsHide: true, env: { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') } });
    assert.equal(child.error, undefined, String(child.error));
    return { child, root, result: JSON.parse(child.stdout) };
  };
  const sourceSpec = specOf(); sourceSpec.routes.shift();
  const cold = run(sourceSpec); assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const bytes = fs.readFileSync(memory, 'utf8');
  const target = specOf(); target.name = 'fourth-power-transfer'; target.routes[0].inputField = 'values';
  target.routes[0].pipeline = { family: 'array-fold', examples: rows([[], [2], [3, 4]], fourth) };
  for (const route of target.routes.filter(route => route.compute)) {
    const fn = route.compute.family === 'array-map' ? square : sum;
    route.compute.examples = rows([[], [6], [-2, 7]], fn);
    route.compute.acceptanceExamples = rows([[8, -3], [9], [1, 2, 3]], fn);
  }
  const warm = run(target); assert.equal(warm.child.status, 0, JSON.stringify(warm.result));
  assert.equal(warm.result.data.projectMemory.state, 'reused');
  assert.ok(warm.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.deepEqual(warm.result.data.plan.computation.pipelines[0].stages, ['/square', '/square', '/sum']);
  assert.equal(warm.result.data.plan.computation.pipelines[0].enumerated, 3);
  assert.equal(warm.result.data.attempts[0].test.exitCode, 0);
  const logic = require(path.join(warm.root, 'src/logic.js'));
  assert.equal(logic.compute(0, [2, 3]), 97);
  assert.throws(() => logic.compute(0, [1001]), /invalid_computation/);
  const chainMemory = path.join(base, 'chain-method.json');
  const learned = run(target, chainMemory); assert.equal(learned.child.status, 0, JSON.stringify(learned.result));
  const chainBytes = fs.readFileSync(chainMemory, 'utf8');
  const chainRecord = JSON.parse(chainBytes);
  assert.equal(chainRecord.programs.filter(program => program.type === 'pipeline').length, 1);
  target.routes[0].path = '/new-fourth-total'; target.routes[1].path = '/new-square'; target.routes[2].path = '/new-sum';
  target.routes[0].pipeline.examples = rows([[], [7], [2, 5]], fourth);
  target.routes[0].acceptanceExamples = rows([[11, -2], [4, 7], [3, 5, 8]], fourth);
  for (const route of target.routes.filter(route => route.compute))
    route.compute.examples = rows([[], [10], [3, -4]], route.compute.family === 'array-map' ? square : sum);
  const reused = run(target, chainMemory); assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.projectMemory.state, 'reused');
  assert.ok(reused.result.data.plan.computation.routes.every(route => route.enumerated === 0));
  assert.equal(reused.result.data.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(reused.result.data.plan.computation.pipelines[0].source, 'memory');
  assert.deepEqual(reused.result.data.plan.computation.pipelines[0].stages, ['/new-square', '/new-square', '/new-sum']);
  target.routes[0].acceptanceExamples[0].expected = 999;
  const bad = run(target, chainMemory); assert.equal(bad.child.status, 6, JSON.stringify(bad.result));
  assert.equal(bad.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(bad.root), []);
  assert.equal(fs.readFileSync(chainMemory, 'utf8'), chainBytes);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
  chainRecord.programs.find(program => program.type === 'pipeline').stages.splice(1, 1);
  const { hash: previousHash, ...body } = chainRecord; assert.equal(typeof previousHash, 'string');
  chainRecord.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const tampered = path.join(base, 'unverified-chain.json'); fs.writeFileSync(tampered, JSON.stringify(chainRecord));
  const refused = run(target, tampered); assert.equal(refused.child.status, 6, JSON.stringify(refused.result));
  assert.match(JSON.stringify(refused.result), /PROJECT_MEMORY_UNVERIFIED_PROGRAM/);
  assert.deepEqual(fs.readdirSync(refused.root), []);
  const direct = { kind: 'project_spec', name: 'direct-reused-chain', archetype: 'node_computed_json_api', routes: [
    { path: '/result', pipeline: { family: 'array-fold', reuseOnly: true, examples: rows([[], [12], [5, 6]], fourth) },
      acceptanceExamples: rows([[13, -5], [8, 9], [4, 6, 7]], fourth) },
  ] };
  const directRun = run(direct, chainMemory);
  assert.equal(directRun.child.status, 0, JSON.stringify(directRun.result));
  assert.deepEqual(directRun.result.data.plan.computation.routes, []);
  assert.equal(directRun.result.data.plan.computation.pipelines[0].enumerated, 0);
  assert.equal(directRun.result.data.attempts[0].test.exitCode, 0);
  assert.equal(fs.readFileSync(chainMemory, 'utf8'), chainBytes);
  const pooledDirect = run(direct, [memory, chainMemory]);
  assert.equal(pooledDirect.child.status, 0, JSON.stringify(pooledDirect.result));
  assert.equal(pooledDirect.result.data.projectMemory.sources.length, 2);
  assert.deepEqual(pooledDirect.result.data.plan.computation.routes, []);
  assert.equal(pooledDirect.result.data.plan.computation.pipelines[0].enumerated, 0);
  const leaked = JSON.parse(JSON.stringify(direct));
  leaked.routes[0].acceptanceExamples[0] = { input: [4], expected: fourth([4]) };
  const sourceOverlap = run(leaked, [memory, chainMemory]);
  assert.equal(sourceOverlap.child.status, 6, JSON.stringify(sourceOverlap.result));
  assert.equal(sourceOverlap.result.data.reason, 'PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  assert.deepEqual(sourceOverlap.result.data.attempts, []);
  assert.deepEqual(fs.readdirSync(sourceOverlap.root), []);
  assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
  assert.equal(fs.readFileSync(chainMemory, 'utf8'), chainBytes);
  direct.routes[0].acceptanceExamples[0].expected = 999;
  const directBad = run(direct, chainMemory);
  assert.equal(directBad.child.status, 6, JSON.stringify(directBad.result));
  assert.equal(directBad.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(directBad.root), []);
});
