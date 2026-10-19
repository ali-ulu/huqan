'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');

test('conditional CLI keeps only independently tested code and reuses its sealed method after restart', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-conditional-')));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const baseline = 'function answer(x) { return x + 1; }\nmodule.exports = answer;\n';
  const nextBaseline = 'function calculate(value) { return value + 1; }\nmodule.exports = calculate;\n';
  write('a.js', baseline);
  write('next.js', nextBaseline);
  write('drift.md', 'no supported function');
  write('ambiguous.md', baseline + baseline);
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const acceptance = (file, valid = true) => write('accept.js',
    `const assert=require('node:assert/strict'),f=require('./${file}');`
    + (valid ? 'for(const x of [-100,-2,1,3,20])assert.equal(f(x),Math.abs(x));' : 'assert.equal(f(20),999);'));
  acceptance('a');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/conditional-fixture']);
  const commit = () => {
    git(['add', 'a.js', 'next.js', 'accept.js', 'drift.md', 'ambiguous.md', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  };
  commit();
  const memoryFile = '.huqan/coder/candidates/absolute.json';
  const task = { id: 'conditional-learning', level: 'l0', allowedPaths: ['a.js'],
    operation: { type: 'replace_text', path: 'a.js' }, test: { command: 'node accept.js' },
    qualificationPaths: ['drift.md', 'ambiguous.md'], synthesis: {
      family: 'conditional-expression', functionName: 'answer', rememberFile: memoryFile,
      examples: [-9, -4, -1, 0, 2, 5, 11].map(input => ({ input, expected: Math.abs(input) })),
    } };
  const journalFile = path.join(root, 'journal.db');
  const cli = (request, id, flags = ['--authorize'], expectedStatus = 0) => {
    write('request.json', JSON.stringify(request));
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder',
      path.join(root, 'request.json'), '--synthesize', '--root', root, '--journal', journalFile,
      '--run-id', id, '--json', ...flags], { cwd: root, env, encoding: 'utf8', timeout: 120000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    assert.ifError(child.error);
    assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
    return JSON.parse(child.stdout).data;
  };
  const denied = cli(task, 'conditional-denied', [], 6);
  assert.equal(denied.outcome, 'needs_human_decision');
  assert.equal(read('a.js'), baseline);
  assert.equal(fs.existsSync(path.join(root, memoryFile)), false);
  const preview = cli(task, 'conditional-preview', ['--authorize', '--dry-run'], 6);
  assert.ok(preview.attempts.every(attempt => attempt.test.ran === false));
  assert.equal(read('a.js'), baseline);
  assert.equal(fs.existsSync(path.join(root, memoryFile)), false);

  acceptance('a', false); commit();
  const failed = cli(task, 'conditional-failed', ['--authorize'], 6);
  assert.ok(failed.attempts.some(attempt => attempt.test.ok === false && attempt.rolledBack === true));
  assert.equal(read('a.js'), baseline);
  assert.equal(fs.existsSync(path.join(root, memoryFile)), false);
  acceptance('a'); commit();
  const learned = cli(task, 'conditional-learned');
  assert.equal(learned.outcome, 'applied_tested');
  assert.equal(learned.synthesis.memory.ok, true, JSON.stringify(learned.synthesis.memory));
  const frozen = read(memoryFile);
  const sourceCode = read('a.js');
  assert.notEqual(sourceCode, baseline);

  acceptance('next'); commit();
  const reuse = structuredClone(task);
  reuse.allowedPaths = ['next.js']; reuse.operation.path = 'next.js';
  reuse.synthesis.functionName = 'calculate'; reuse.synthesis.reuseMemory = true;
  reuse.synthesis.rememberFile = '.huqan/coder/candidates/unneeded-copy.json';
  const reused = cli(reuse, 'conditional-restarted');
  assert.equal(reused.synthesis.memoryReuse.attempted, true);
  assert.equal(reused.synthesis.enumerated, 0);
  assert.equal(reused.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(reused.attempts[0].test.ok, true);
  assert.equal(read('a.js'), sourceCode);
  assert.match(read('next.js'), /function calculate\(value\)/);
  assert.equal(read(memoryFile), frozen);
  assert.equal(fs.existsSync(path.join(root, reuse.synthesis.rememberFile)), false);

  write('next.js', nextBaseline); acceptance('next', false); commit();
  const store = openCoderJournal(journalFile);
  try {
    const veto = runArithmeticSynthesis({ task: reuse, root, journal: store.journal,
      authorized: true, maxCandidates: 1, runId: 'conditional-veto',
      repoState: { branch: 'codex/conditional-fixture', dirty: false, hasUntracked: false } });
    assert.equal(veto.reason, 'SYNTHESIS_BUDGET_EXHAUSTED', JSON.stringify(veto));
    assert.equal(veto.attempts.length, 1);
    assert.equal(veto.attempts[0].test.ok, false);
    assert.equal(veto.attempts[0].rolledBack, true);
    assert.equal(veto.synthesis.memoryReuse.fallback, undefined);
  } finally { store.close(); }
  assert.equal(read('next.js'), nextBaseline);
  assert.equal(read(memoryFile), frozen);
  acceptance('next'); commit();
  const forged = JSON.parse(frozen);
  forged.params.newText = 'function answer(x) { return 999; }';
  const { hash: unusedHash, ...body } = forged;
  forged.hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  write(memoryFile, JSON.stringify(forged));
  const corrupted = cli(reuse, 'conditional-corrupted', ['--authorize'], 6);
  assert.equal(corrupted.attempts.length, 0);
  assert.equal(read('next.js'), nextBaseline);
  assert.equal(fs.existsSync(path.join(root, reuse.synthesis.rememberFile)), false);
});

test('a rejected remembered conditional shares the candidate budget with fresh search after verified rollback', t => {
  for (const budget of [1, 2]) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-conditional-budget-')));
    t.after(() => {
      assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
    const baseline = 'function answer(x) { return x + 1; }\nmodule.exports = answer;';
    const next = 'function calculate(value) { return value + 1; }\nmodule.exports = calculate;';
    write('a.js', baseline); write('next.js', next);
    write('drift.md', 'no supported function'); write('ambiguous.md', baseline + baseline);
    write('accept.js', "const assert=require('node:assert/strict'),f=require('./a');assert.equal(f(2),2);assert.equal(f(3),3);");
    const task = { id: 'conditional-budget', level: 'l0', allowedPaths: ['a.js'],
      operation: { type: 'replace_text', path: 'a.js' }, test: { command: 'node accept.js' },
      qualificationPaths: ['drift.md', 'ambiguous.md'], synthesis: {
        family: 'conditional-expression', functionName: 'answer',
        examples: [-1, 0, 1].map(input => ({ input, expected: Math.abs(input) })),
        rememberFile: '.huqan/coder/candidates/source.json',
      } };
    const store = openCoderJournal(path.join(root, 'journal.db'));
    const options = { root, journal: store.journal, authorized: true,
      repoState: { branch: 'codex/conditional-fixture', dirty: false, hasUntracked: false } };
    try {
      const cold = runArithmeticSynthesis({ ...options, task, maxCandidates: 1, runId: `conditional-cold-${budget}` });
      assert.equal(cold.ok, true, JSON.stringify(cold));
      assert.equal(cold.synthesis.memory.ok, true, JSON.stringify(cold.synthesis.memory));
      const frozen = fs.readFileSync(path.join(root, task.synthesis.rememberFile), 'utf8');
      write('accept.js', "const assert=require('node:assert/strict'),f=require('./next');assert.equal(f(2),1);assert.equal(f(3),1);");
      const warmTask = { ...task, allowedPaths: ['next.js'], operation: { type: 'replace_text', path: 'next.js' },
        synthesis: { ...task.synthesis, functionName: 'calculate', reuseMemory: true,
          rememberFile: '.huqan/coder/candidates/fallback.json' } };
      const warm = runArithmeticSynthesis({ ...options, task: warmTask, maxCandidates: budget,
        runId: `conditional-warm-${budget}` });
      assert.equal(warm.synthesis.memoryReuse.attempted, true);
      assert.equal(warm.attempts[0].test.ok, false);
      assert.equal(warm.attempts[0].rolledBack, true);
      assert.equal(fs.readFileSync(path.join(root, task.synthesis.rememberFile), 'utf8'), frozen);
      if (budget === 1) {
        assert.equal(warm.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
        assert.equal(warm.attempts.length, 1);
        assert.equal(fs.readFileSync(path.join(root, 'next.js'), 'utf8'), next);
        assert.equal(fs.existsSync(path.join(root, warmTask.synthesis.rememberFile)), false);
      } else {
        assert.equal(warm.ok, true, JSON.stringify(warm));
        assert.equal(warm.attempts.length, 2);
        assert.equal(warm.attempts[0].stage, 'memory');
        assert.equal(warm.attempts[1].stage, 'search');
        assert.equal(warm.attempts[1].candidate, 2);
        assert.equal(warm.attempts[1].test.ok, true);
        assert.equal(warm.synthesis.memory.ok, true, JSON.stringify(warm.synthesis.memory));
        const learned = JSON.parse(fs.readFileSync(path.join(root, warmTask.synthesis.rememberFile), 'utf8'));
        assert.equal(learned.runId, warm.synthesis.sourceRunId);
        assert.notEqual(learned.params.newText, JSON.parse(frozen).params.newText);
      }
    } finally { store.close(); }
  }
});
