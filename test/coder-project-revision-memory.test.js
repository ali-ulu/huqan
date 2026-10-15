'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceProject, produceProjectRevision } = require('../lib/coder/project-producer');
const { runCliProjectRevisionMemory } = require('../lib/cli-coder-project-memory');
const { runCliCoder } = require('../lib/cli-coder');
const { loadProjectMethods } = require('../lib/coder/project-method-memory');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { readSealedRun } = require('../lib/experience/learning-intake');

function requirements() {
  const previous = { kind: 'project_spec', name: 'learned-revision', archetype: 'node_computed_json_api', routes: [{
    path: '/sum', compute: { family: 'array-fold', examples: [
      { input: [], expected: 0 }, { input: [1, 2], expected: 3 }, { input: [-3, 5], expected: 2 }],
    acceptanceExamples: [{ input: [8, 2], expected: 10 }, { input: [-7, 3], expected: -4 }, { input: [4], expected: 4 }] }
  }] };
  const next = structuredClone(previous);
  next.routes.push({ path: '/max', compute: { family: 'array-stateful-fold', examples: [
    { input: [], expected: 0 }, { input: [2, 5], expected: 5 }, { input: [5, 2], expected: 5 },
    { input: [-4, -2], expected: -2 }, { input: [-2, 7, 1], expected: 7 }],
  acceptanceExamples: [{ input: [6, 9], expected: 9 }, { input: [-8, -3], expected: -3 }, { input: [22], expected: 22 }] } });
  return { kind: 'project_revision', previous, next };
}
function methods() {
  const spec = requirements();
  const teacher = produceProject(spec.next);
  assert.equal(teacher.ok, true, teacher.reason);
  return { ok: true, found: true, hash: 'f'.repeat(64), replaySearch: 17, sources: [{ file: 'sealed-source.json' }],
    programs: teacher.plan.computation.routes.map(route => route.program), methodContexts: [], pipelineContexts: [] };
}

test('project commands reject candidate files before reading any source or opening a journal', () => {
  for (const mode of ['create', 'revise']) for (const memory of [[], ['--project-memory', 'source.json']])
    for (const candidate of [['--candidate-file', 'candidate.json'], ['--candidate-file', '']])
      assert.throws(() => runCliCoder([mode, 'absent.json', ...memory, '--journal', 'absent-journal.db', ...candidate], {}),
        /Candidate memory requires a journal, candidate file and a non-project task/u);
});

test('revision reuses methods for both baseline and new requirements without changing patch bodies', () => {
  const spec = requirements(), memory = methods();
  const cold = produceProjectRevision(spec);
  const warm = produceProjectRevision(spec, { candidatePrograms: memory.programs });
  assert.equal(warm.ok, true, warm.reason);
  assert.ok(cold.plan.computation.routes.some(route => route.enumerated > 0));
  assert.ok(warm.plan.computation.routes.every(route => route.enumerated === 0 && route.source === 'memory'));
  assert.deepEqual(warm.task.expectedPatch, cold.task.expectedPatch);
  assert.equal(produceProjectRevision(spec, { candidatePrograms: memory.programs.slice(0, 1) }).reason,
    'PROJECT_COMPUTE_MEMORY_NO_MATCH');
});

function harness(memory = methods(), authorized = true) {
  const calls = []; let closes = 0;
  const journal = {};
  const input = { spec: requirements(), root: 'target', flags: { projectMemory: ['sealed-source.json'], journal: 'journal.db', authorize: authorized },
    repoState: { known: true, branch: 'feature/revision', dirty: false, hasUntracked: false },
    openJournal: () => ({ journal, close: () => { closes += 1; } }),
    opts: { json: true, workspaceId: 'workspace-a', coderLoop: {
      loadProjectMethods: options => { calls.push(['load', options]); return memory; },
      produceProjectRevision: (spec, options) => { calls.push(['produce', options]); return produceProjectRevision(spec, options); },
      runFixLoop: options => { calls.push(['run', options]); return { ok: true, outcome: 'applied_tested', attempts: [], kept: [], record: {} }; },
      formatLoopText: () => 'formatted'
    } } };
  return { input, calls, journal, closes: () => closes };
}

test('memory revision delegates the bound task to the ordinary loop without initialization authority', () => {
  for (const authorized of [false, true]) {
    const h = harness(methods(), authorized);
    const result = runCliProjectRevisionMemory(h.input);
    assert.equal(result.status, 'completed'); // This test observes orchestration; the loop is injected.
    assert.deepEqual(h.calls.map(call => call[0]), ['load', 'produce', 'run']);
    const load = h.calls[0][1], run = h.calls[2][1];
    assert.equal(load.workspaceId, 'workspace-a'); assert.equal(load.journal, h.journal);
    assert.equal(load.sourceRoot, h.input.root);
    assert.equal(run.authorized, authorized); assert.equal(run.journal, h.journal);
    assert.equal(Object.hasOwn(run, 'projectInitializationPermission'), false);
    assert.ok(run.task.id.endsWith(`-methods-${'f'.repeat(64)}`));
    assert.ok(result.data.plan.computation.routes.every(route => route.enumerated === 0));
    assert.equal(result.data.projectMemory.state, 'loaded'); assert.equal(result.data.projectMemory.replaySearch, 17);
    assert.equal(h.closes(), 1);
  }
});

test('missing or invalid source refuses before proposal or loop and always closes the journal', () => {
  for (const memory of [{ ok: true, found: false }, { ok: false, reason: 'PROJECT_MEMORY_HASH_MISMATCH' }]) {
    const h = harness(memory);
    const result = runCliProjectRevisionMemory(h.input);
    assert.equal(result.status, 'refused');
    assert.equal(result.data.reason, memory.reason || 'PROJECT_MEMORY_NOT_FOUND');
    assert.deepEqual(h.calls.map(call => call[0]), ['load']); assert.equal(h.closes(), 1);
  }
  const h = harness(); h.input.opts.coderLoop.loadProjectMethods = () => { throw new Error('unavailable'); };
  assert.throws(() => runCliProjectRevisionMemory(h.input), /unavailable/u);
  assert.equal(h.closes(), 1);
});

test('CLI refuses initialization and method output without an input source before reading a spec', () => {
  for (const flags of [[], ['--journal', 'journal.db', '--dry-run']])
    assert.throws(() => runCliCoder(['revise', 'absent.json', '--project-memory', 'source.json', ...flags], {}),
      /Project revision memory requires --journal without --dry-run/u);
  assert.throws(() => runCliCoder(['revise', 'absent.json', '--initialize-project'], {}),
    /Project revision uses the existing repository gate without initialization/u);
  assert.throws(() => runCliCoder(['revise', 'absent.json', '--project-memory-out', 'new.json'], {}),
    /--project-memory-out requires --project-memory/u);
});

test('real loader reaches record validation and preserves the existing repository boundary', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-revision-memory-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const outside = path.join(base, 'invalid.json'), inside = path.join(root, 'inside.json');
  for (const file of [outside, inside]) fs.writeFileSync(file, '{}');
  for (const [file, reason] of [[outside, 'PROJECT_MEMORY_INVALID'], [inside, 'PROJECT_MEMORY_OVERLAPS_PROJECT'],
    [path.join(base, 'missing.json'), 'PROJECT_MEMORY_NOT_FOUND']]) {
    const h = harness(); h.input.root = root; h.input.flags.projectMemory = file;
    h.input.opts.coderLoop.loadProjectMethods = loadProjectMethods;
    const result = runCliProjectRevisionMemory(h.input);
    assert.equal(result.status, 'refused'); assert.equal(result.data.reason, reason);
    assert.equal(h.calls.length, 0); assert.equal(h.closes(), 1);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}'); assert.equal(fs.readFileSync(inside, 'utf8'), '{}');
});

test('native sealed memory extends existing projects and preserves authorization and rollback', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-revision-sealed-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = (root, args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  const commit = root => {
    git(root, ['init', '-b', 'codex/fixture']); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  };
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const journal = path.join(base, 'journal.db'), memory = path.join(base, 'methods.json');
  const run = args => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', ...args,
      '--journal', journal, '--json'], { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const source = path.join(base, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture'); commit(source);
  const teacher = path.join(base, 'teacher'); fs.mkdirSync(teacher);
  const spec = requirements(), teachingFile = path.join(base, 'teach.json');
  fs.writeFileSync(teachingFile, JSON.stringify(spec.next));
  const learned = run(['create', teachingFile, '--root', teacher, '--initialize-project', '--source-root', source,
    '--project-memory', memory, '--run-id', 'revision-teacher']);
  assert.equal(learned.child.status, 0, JSON.stringify(learned.result));
  const bytes = fs.readFileSync(memory, 'utf8');
  const revisionFile = path.join(base, 'revision.json'); fs.writeFileSync(revisionFile, JSON.stringify(spec));
  for (const mode of ['success', 'unauthorized', 'failed-old-test', 'unchanged-drift']) {
    const root = path.join(base, mode); fs.mkdirSync(root);
    const baseline = produceProject(spec.previous); assert.equal(baseline.ok, true, baseline.reason);
    for (const step of baseline.task.operation.steps) {
      const file = path.join(root, step.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, step.content);
    }
    fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
    if (mode === 'unchanged-drift') fs.appendFileSync(path.join(root, 'src', 'server.js'), '\n// local customization\n');
    fs.writeFileSync(path.join(root, 'test', 'sidecar.test.js'),
      `require('node:assert/strict').equal(require('node:fs').readFileSync('notes.txt', 'utf8'), '${mode === 'failed-old-test' ? 'different' : 'keep'}');`);
    commit(root);
    const originals = baseline.task.operation.steps.map(step => [step.path, fs.readFileSync(path.join(root, step.path), 'utf8')]);
    const { child, result } = run(['revise', revisionFile, '--root', root, '--project-memory', memory,
      ...(mode === 'unauthorized' ? [] : ['--authorize']), '--run-id', `revision-${mode}`]);
    assert.equal(child.status, mode === 'success' ? 0 : 6, JSON.stringify(result));
    assert.equal(result.data.projectMemory.state, 'loaded');
    assert.ok(result.data.plan.computation.routes.every(route => route.source === 'memory' && route.enumerated === 0));
    if (mode === 'success') {
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      assert.equal(result.data.record.observedVerification.ok, true);
      assert.equal(result.data.projectRevision.ok, true);
      assert.equal(result.data.projectRevision.outputs.length, baseline.task.operation.steps.length);
      const store = openCoderJournal(journal);
      try {
        const sealed = readSealedRun(store.journal, 'revision-success:c1', 'default');
        assert.equal(sealed.ok, true, sealed.code);
        assert.deepEqual(sealed.events.find(event => event.type === 'run_closed').payload.evidence.projectRevision,
          result.data.projectRevision);
      } finally { store.close(); }
      assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'routes.json'), 'utf8')).some(route => route.path === '/max'));
    } else {
      for (const [file, text] of originals) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), text);
      if (mode === 'failed-old-test') assert.equal(result.data.attempts[0].rolledBack, true);
      if (mode === 'unchanged-drift') {
        assert.equal(result.data.attempts[0].rolledBack, true);
        assert.equal(result.data.attempts[0].test.reason, 'PROJECT_REVISION_OUTPUT_MISMATCH');
      }
    }
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(memory, 'utf8'), bytes);
  }
});
