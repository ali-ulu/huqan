'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');

test('produces extrema logic from training without using acceptance answers to select', () => {
  const examples = [[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]];
  const oracle = input => input.length ? [...input].sort((a, b) => b - a)[0] : 0;
  const spec = { kind: 'project_spec', name: 'stateful-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/largest', compute: { family: 'array-stateful-fold',
      examples: examples.map(input => ({ input, expected: oracle(input) })),
      acceptanceExamples: [{ input: [-90, -40], expected: -40 }, { input: [500, 4, 500], expected: 500 },
        { input: [-777, -11], expected: -11 }] } }] };
  const produced = produceProject(spec);
  assert.equal(produced.ok, true, produced.reason);
  const selected = produced.plan.computation.routes[0];
  assert.equal(selected.program.type, 'stateful-fold');
  assert.equal(selected.enumerated, 48);
  const logic = produced.task.operation.steps.find(step => step.path === 'src/logic.js').content;
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(logic, context);
  for (const input of [[], [-100, -30], [8], [-1000000, 1000000]])
    assert.equal(context.module.exports.compute(0, input), oracle(input));
  spec.routes[0].compute.acceptanceExamples[0].expected = 123;
  assert.deepEqual(produceProject(spec).plan.computation.routes[0], selected);
  const reused = produceProject(spec, { candidatePrograms: [selected.program] });
  assert.equal(reused.ok, true, reused.reason);
  assert.equal(reused.plan.computation.routes[0].enumerated, 0);
});

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const file = path.join(base, 'method.json'); const journal = path.join(base, 'journal.db');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (spec, memoryFile = file, memoryOut) => {
    sequence += 1; const root = path.join(base, `target-${sequence}`); fs.mkdirSync(root);
    const specFile = path.join(base, `spec-${sequence}.json`); fs.writeFileSync(specFile, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', specFile,
      '--root', root, '--initialize-project', '--source-root', source, '--journal', journal,
      ...[].concat(memoryFile).flatMap(file => ['--project-memory', file]),
      ...(memoryOut === undefined ? [] : ['--project-memory-out', memoryOut]), '--run-id', `memory-${sequence}`, '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result, root };
  };
  return { run, file, source, base };
}


test('native CLI learns extrema, reopens sealed memory and rolls back wrong HTTP acceptance', t => {
  const context = fixture(t);
  const oracle = input => input.length ? [...input].sort((a, b) => b - a)[0] : 0;
  const rows = inputs => inputs.map(input => ({ input, expected: oracle(input) }));
  const source = { kind: 'project_spec', name: 'maximum-source', archetype: 'node_computed_json_api',
    routes: [{ path: '/maximum', compute: { family: 'array-stateful-fold',
      examples: rows([[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]]),
      acceptanceExamples: rows([[-90, -40], [500, 4, 500], [-777, -11]]) } }] };
  const cold = context.run(source);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  assert.equal(cold.result.data.attempts[0].test.exitCode, 0);
  assert.equal(cold.result.data.plan.computation.routes[0].enumerated, 48);
  const bytes = fs.readFileSync(context.file, 'utf8');
  const target = JSON.parse(JSON.stringify(source));
  target.name = 'maximum-target'; target.routes[0].path = '/largest';
  target.routes[0].inputField = 'numbers';
  target.routes[0].compute.examples = rows([[], [8, -9], [-12, -6], [5, 3, 9], [9, 3, 5]]);
  target.routes[0].compute.acceptanceExamples = rows([[-100, -30], [1000000, -1000000], Array.from({ length: 128 }, (_, at) => at - 100)]);
  const reused = context.run(target);
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.attempts[0].test.exitCode, 0);
  assert.equal(reused.result.data.plan.computation.routes[0].enumerated, 0);
  const wrong = JSON.parse(JSON.stringify(target));
  wrong.routes[0].compute.acceptanceExamples[0].expected = 999;
  const rejected = context.run(wrong);
  assert.equal(rejected.child.status, 6, JSON.stringify(rejected.result));
  assert.equal(rejected.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(rejected.root), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), bytes);
});

test('native minimum synthesis verifies negative and boundary HTTP inputs', t => {
  const context = fixture(t);
  const oracle = input => input.length ? [...input].sort((a, b) => a - b)[0] : 0;
  const rows = inputs => inputs.map(input => ({ input, expected: oracle(input) }));
  const spec = { kind: 'project_spec', name: 'minimum-source', archetype: 'node_computed_json_api',
    routes: [{ path: '/minimum', compute: { family: 'array-stateful-fold',
      examples: rows([[], [2, 5], [5, 2], [3, 1, 4], [-4, -2], [-2, 7, 1]]),
      acceptanceExamples: rows([[-90, -40], [1000000, -1000000], Array.from({ length: 128 }, (_, at) => at - 100)]) } }] };
  const result = context.run(spec);
  assert.equal(result.child.status, 0, JSON.stringify(result.result));
  assert.equal(result.result.data.attempts[0].test.exitCode, 0);
  assert.equal(result.result.data.plan.computation.routes[0].program.guard.operator, '<');
  assert.equal(result.result.data.plan.computation.routes[0].enumerated, 48);
  assert.equal(fs.existsSync(context.file), true);
});
