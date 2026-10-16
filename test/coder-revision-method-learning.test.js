'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { produceProject } = require('../lib/coder/project-producer');
const { createHash } = require('node:crypto');

test('native revision learns a new method, seals it and transfers after restart without target search', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-revision-learn-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = (root, args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  const commit = root => {
    git(root, ['init', '-b', 'codex/fixture']); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  };
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); commit(source);
  const journal = path.join(base, 'journal.db'), parent = path.join(base, 'parent.json');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (mode, spec, root, flags) => {
    const id = `learn-${++sequence}`, file = path.join(base, `${id}.json`); fs.writeFileSync(file, JSON.stringify(spec));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', mode, file,
      '--root', root, '--journal', journal, '--run-id', id, '--json', ...flags],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const row = (input, expected) => ({ input, expected });
  const previous = { kind: 'project_spec', name: 'learning-api', archetype: 'node_computed_json_api', routes: [{
    path: '/sum', compute: { family: 'array-fold', examples: [row([], 0), row([1, 2], 3), row([-3, 5], 2)],
      acceptanceExamples: [row([8, 2], 10), row([-7, 3], -4), row([4], 4)] }
  }] };
  const next = structuredClone(previous);
  next.routes.push({ path: '/max', compute: { family: 'array-stateful-fold', synthesizeOnMemoryMiss: true,
    examples: [row([], 0), row([2, 5], 5), row([5, 2], 5), row([-4, -2], -2), row([-2, 7, 1], 7)],
    acceptanceExamples: [row([6, 9], 9), row([-8, -3], -3), row([22], 22)] } });
  const teacher = path.join(base, 'teacher'); fs.mkdirSync(teacher);
  const taught = run('create', previous, teacher, ['--initialize-project', '--source-root', source, '--project-memory', parent]);
  assert.equal(taught.child.status, 0, JSON.stringify(taught.result));
  const originalParent = fs.readFileSync(parent, 'utf8');
  const enumeration = plan => (plan.baselineSearch || 0)
    + plan.computation.routes.reduce((sum, route) => sum + route.enumerated, 0)
    + (plan.computation.pipelines || []).reduce((sum, pipeline) => sum + (pipeline.enumerated || 0), 0);
  let revisionTrainingSearch = 0;
  const learned = path.join(base, 'learned.json');
  for (const mode of ['success', 'unauthorized', 'failed-old-test']) {
    const root = path.join(base, mode); fs.mkdirSync(root);
    const baseline = produceProject(previous); assert.equal(baseline.ok, true, baseline.reason);
    for (const step of baseline.task.operation.steps) {
      const target = path.join(root, step.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, step.content);
    }
    fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
    fs.writeFileSync(path.join(root, 'test', 'sidecar.test.js'),
      `require('node:assert/strict').equal(require('node:fs').readFileSync('notes.txt','utf8'),'${mode === 'failed-old-test' ? 'different' : 'keep'}');`);
    commit(root);
    const output = mode === 'success' ? learned : path.join(base, `${mode}-memory.json`);
    const revised = run('revise', { kind: 'project_revision', previous, next }, root,
      ['--project-memory', parent, '--project-memory-out', output, ...(mode === 'unauthorized' ? [] : ['--authorize'])]);
    assert.equal(revised.child.status, mode === 'success' ? 0 : 6, JSON.stringify(revised.result));
    if (mode === 'success') {
      revisionTrainingSearch = enumeration(revised.result.data.plan);
      assert.equal(revised.result.data.projectMemory.state, 'remembered');
      assert.equal(revised.result.data.plan.computation.routes[1].source, 'synthesis-after-memory-miss');
      assert.ok(revised.result.data.plan.computation.routes[1].enumerated > 0);
      assert.equal(JSON.parse(fs.readFileSync(learned, 'utf8')).format, 'huqan-project-revision-method');
    } else {
      assert.equal(fs.existsSync(output), false);
      for (const step of baseline.task.operation.steps) assert.equal(fs.readFileSync(path.join(root, step.path), 'utf8'), step.content);
      if (mode === 'failed-old-test') assert.equal(revised.result.data.attempts[0].rolledBack, true);
    }
    assert.equal(fs.readFileSync(parent, 'utf8'), originalParent);
  }
  const target = { ...structuredClone(previous), name: 'transfer-api', routes: [{ path: '/largest', compute: {
    family: 'array-stateful-fold', examples: [row([], 0), row([3, 8], 8), row([8, 3], 8), row([-8, -1], -1)],
    acceptanceExamples: [row([9, 2], 9), row([-7, -6], -6), row([30], 30)] } }] };
  const transferred = path.join(base, 'transferred'); fs.mkdirSync(transferred);
  const reused = run('create', target, transferred, ['--initialize-project', '--source-root', source, '--project-memory', learned]);
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.plan.computation.routes[0].enumerated, 0);
  assert.equal(reused.result.data.plan.computation.routes[0].source, 'memory');
  assert.equal(reused.result.data.projectMemory.replaySearch, 0);
  const coldRoot = path.join(base, 'cold-target'); fs.mkdirSync(coldRoot);
  const cold = run('create', target, coldRoot, ['--initialize-project', '--source-root', source]);
  assert.equal(cold.child.status, 0, JSON.stringify(cold.result));
  const coldSearch = cold.result.data.plan.computation.routes.reduce((sum, route) => sum + route.enumerated, 0);
  assert.ok(coldSearch > 0);
  assert.deepEqual(cold.result.data.plan.computation.routes.map(route => route.program),
    reused.result.data.plan.computation.routes.map(route => route.program));
  console.log(JSON.stringify({ measure: 'reported-plan-candidate-enumeration-only', initialTeachingPlan: enumeration(taught.result.data.plan),
    revisionLearningPlan: revisionTrainingSearch, coldTargetPlan: coldSearch,
    warmSourceReplay: reused.result.data.projectMemory.replaySearch, warmTarget: 0,
    additionalVerifierEnumeration: 'NOT_COUNTED', totalLearningCost: 'NOT_MEASURED',
    cpuAndNativeVerificationGain: 'NOT_MEASURED' }));
  assert.equal(reused.result.data.attempts[0].test.exitCode, 0);
  const mutations = [
    [record => { record.sourceHash = '0'.repeat(64); }, 'PROJECT_MEMORY_SOURCE_CHANGED'],
    [record => { record.memoryHash = '0'.repeat(64); }, 'PROJECT_MEMORY_PARENT_BINDING_MISMATCH'],
    [record => { record.sourceRevision.previous.name = 'forged-before'; }, 'PROJECT_MEMORY_PARENT_BINDING_MISMATCH'],
    [record => { record.parents[0].sourceHash = '0'.repeat(64); }, 'PROJECT_MEMORY_PARENT_CHANGED'],
  ];
  for (const [index, [mutate, reason]] of mutations.entries()) {
    const corrupted = JSON.parse(fs.readFileSync(learned, 'utf8')); mutate(corrupted);
    const { hash: ignored, ...body } = corrupted; void ignored;
    corrupted.hash = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
    const tampered = path.join(base, `tampered-${index}.json`); fs.writeFileSync(tampered, JSON.stringify(corrupted));
    const refusedRoot = path.join(base, `refused-${index}`); fs.mkdirSync(refusedRoot);
    const refused = run('create', target, refusedRoot, ['--initialize-project', '--source-root', source, '--project-memory', tampered]);
    assert.equal(refused.child.status, 6, JSON.stringify(refused.result));
    assert.equal(refused.result.data.reason, reason);
    assert.deepEqual(fs.readdirSync(refusedRoot), []);
  }
});
