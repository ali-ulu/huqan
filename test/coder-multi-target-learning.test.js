'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { runFixLoop } = require('../lib/coder/fix-loop');
const { rememberCandidate } = require('../lib/coder/learned-candidate');

test('multi-target synthesis remembers only kept results and a restarted CLI reuses the sealed method', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-multi-learn-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseline = 'module.exports = x => x + 1;\n';
  const reset = () => { for (const file of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, file), baseline); };
  reset();
  const acceptance = expected => fs.writeFileSync(path.join(root, 'accept.js'),
    `const assert=require('node:assert/strict');assert.equal(require('./a')(7),19);assert.equal(require('./b')(11),${expected});`);
  acceptance(27);
  fs.writeFileSync(path.join(root, 'drift.json'), JSON.stringify({ 'a.js': 'missing', 'b.js': 'missing' }));
  fs.writeFileSync(path.join(root, 'ambiguous.json'), JSON.stringify({ 'a.js': baseline + baseline, 'b.js': baseline }));
  const task = { id: 'multi-learn', level: 'l0', allowedPaths: ['a.js', 'b.js'],
    operation: { type: 'sequence' }, qualificationPaths: ['drift.json', 'ambiguous.json'], test: { command: 'node accept.js' },
    synthesis: { family: 'multi-target', rememberFile: '.huqan/coder/candidates/joint.json', targets: [
      { path: 'a.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 3 - 2 })) },
      { path: 'b.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 2 + 5 })) },
    ] } };
  const journalFile = path.join(root, 'journal.db');
  const store = openCoderJournal(journalFile); let clock = 0;
  const journal = budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) });
  const options = { root, journal, repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } };
  try {
    const denied = runArithmeticSynthesis({ ...options, task, authorized: false, runId: 'denied' });
    assert.equal(denied.ok, false);
    assert.equal(fs.existsSync(path.join(root, task.synthesis.rememberFile)), false);
    acceptance(999);
    const failed = runArithmeticSynthesis({ ...options, task, authorized: true, runId: 'failed' });
    assert.equal(failed.ok, false);
    assert.equal(failed.attempts[0].rolledBack, true);
    assert.equal(fs.existsSync(path.join(root, task.synthesis.rememberFile)), false);
    for (const file of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), baseline);
    acceptance(27);
    const learned = runArithmeticSynthesis({ ...options, task, authorized: true, runId: 'learned' });
    assert.equal(learned.ok, true, JSON.stringify(learned));
    assert.equal(learned.synthesis.memory.ok, true, JSON.stringify(learned.synthesis.memory));
  } finally { store.close(); }
  const memoryPath = path.join(root, task.synthesis.rememberFile), frozen = fs.readFileSync(memoryPath, 'utf8');
  reset();
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/fixture']); git(['add', '.']);
  const commit = () => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  commit();
  const request = structuredClone(task); request.synthesis.reuseMemory = true;
  request.synthesis.rememberFile = '.huqan/coder/candidates/unneeded-copy.json';
  const file = path.join(root, 'request.json'); fs.writeFileSync(file, JSON.stringify(request));
  const run = id => {
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'state') }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file, '--synthesize', '--authorize',
      '--root', root, '--journal', journalFile, '--run-id', id, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.ifError(child.error); return { child, result: JSON.parse(child.stdout) };
  };
  const reused = run('restarted');
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.synthesis.memoryReuse.attempted, true);
  assert.equal(reused.result.data.synthesis.enumerated, 0);
  assert.equal(reused.result.data.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(fs.existsSync(path.join(root, request.synthesis.rememberFile)), false);
  assert.equal(fs.readFileSync(memoryPath, 'utf8'), frozen);
  reset(); acceptance(999); git(['add', '.']); commit();
  const veto = run('veto');
  assert.equal(veto.child.status, 6, JSON.stringify(veto.result));
  assert.equal(veto.result.data.attempts[0].rolledBack, true);
  for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
  assert.equal(fs.readFileSync(memoryPath, 'utf8'), frozen);
  const forged = JSON.parse(frozen); forged.params.steps[0].newText = '0';
  const { hash: unusedHash, ...body } = forged;
  forged.hash = require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(memoryPath, JSON.stringify(forged));
  const corrupted = run('corrupted');
  assert.equal(corrupted.child.status, 6, JSON.stringify(corrupted.result));
  assert.equal(corrupted.result.data.attempts.length, 0);
  for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
});

test('a training-compatible joint method failing holdout is rolled back before bounded different-method synthesis', t => {
  for (const budget of [1, 2]) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-joint-retry-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const baseline = 'module.exports = x => x + 1;\n';
    const reset = () => { for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), baseline); };
    reset();
    fs.writeFileSync(path.join(root, 'accept.js'),
      "const assert=require('node:assert/strict');assert.equal(require('./a')(1),-2);assert.equal(require('./b')(5),15);");
    fs.writeFileSync(path.join(root, 'drift.json'), JSON.stringify({ 'a.js': 'missing', 'b.js': 'missing' }));
    fs.writeFileSync(path.join(root, 'ambiguous.json'), JSON.stringify({ 'a.js': baseline + baseline, 'b.js': baseline }));
    const qualifications = ['drift.json', 'ambiguous.json'];
    const source = { id: 'source', level: 'l0', allowedPaths: ['a.js', 'b.js'], test: { command: 'node accept.js' },
      operation: { type: 'sequence', steps: [
        { type: 'replace_text', path: 'a.js', find: 'x + 1', replace: '((x - 3) % 3)' },
        { type: 'replace_text', path: 'b.js', find: 'x + 1', replace: '((x * 2) + 5)' },
      ] } };
    const store = openCoderJournal(path.join(root, 'journal.db')); let clock = 0;
    const journal = budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) });
    const options = { root, journal, authorized: true, repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } };
    try {
      assert.equal(runFixLoop({ ...options, task: source, runId: 'source' }).ok, true);
      const memoryFile = '.huqan/coder/candidates/source.json';
      const saved = rememberCandidate({ task: source, root, journal, runId: 'source:c1', workspaceId: 'default',
        file: memoryFile, qualificationPaths: qualifications });
      assert.equal(saved.ok, true, saved.reason);
      const frozen = fs.readFileSync(path.join(root, memoryFile), 'utf8');
      reset();
      fs.writeFileSync(path.join(root, 'accept.js'),
        "const assert=require('node:assert/strict');assert.equal(require('./a')(1),1);assert.equal(require('./b')(7),19);");
      const target = { ...source, id: 'target', operation: { type: 'sequence' }, qualificationPaths: qualifications,
        synthesis: { family: 'multi-target', reuseMemory: true, rememberFile: '.huqan/coder/candidates/fresh.json', targets: [
          { path: 'a.js', family: 'arithmetic-expression', examples: [
            { input: -5, expected: -2 }, { input: -4, expected: -1 }, { input: -2, expected: -2 }] },
          { path: 'b.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 2 + 5 })) },
        ] } };
      const result = runArithmeticSynthesis({ ...options, task: target, runId: 'target', maxCandidates: budget });
      assert.equal(result.ok, budget === 2, JSON.stringify(result));
      assert.equal(result.attempts[0].rolledBack, true);
      assert.equal(result.attempts.length, budget);
      assert.equal(fs.readFileSync(path.join(root, memoryFile), 'utf8'), frozen);
      if (budget === 1) {
        assert.equal(result.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
        for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
        assert.equal(fs.existsSync(path.join(root, target.synthesis.rememberFile)), false);
      } else {
        assert.equal(result.attempts[0].stage, 'memory');
        assert.equal(result.attempts[1].stage, 'search');
        assert.equal(result.attempts[1].test.exitCode, 0);
        assert.equal(result.synthesis.selectedCandidate, 2);
        assert.equal(result.synthesis.excludedCandidates, 1);
        assert.equal(result.synthesis.memory.ok, true);
        assert.equal(result.synthesis.sourceRunId, 'target:search:c1');
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, target.synthesis.rememberFile), 'utf8')).runId, 'target:search:c1');
      }
    } finally { store.close(); }
  }
});
