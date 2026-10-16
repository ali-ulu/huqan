'use strict';

const test = require('node:test');
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

test('pipeline remembers only a kept pair and a fresh CLI transfers it without fresh enumeration', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pipeline-learn-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseline = 'module.exports = x => x + 1;\n';
  const reset = paths => { for (const file of paths) fs.writeFileSync(path.join(root, file), baseline); };
  reset(['a.js', 'b.js']);
  const acceptance = (a, b, expected) => fs.writeFileSync(path.join(root, 'accept.js'),
    `const assert=require('node:assert/strict');assert.equal(require('./${b}')(require('./${a}')(5)),${expected});`);
  acceptance('a.js', 'b.js', 625);
  fs.writeFileSync(path.join(root, 'drift.json'), JSON.stringify({ 'a.js': 'missing', 'b.js': 'missing' }));
  fs.writeFileSync(path.join(root, 'ambiguous.json'), JSON.stringify({ 'a.js': baseline + baseline, 'b.js': baseline }));
  const task = { id: 'pipeline-learn', level: 'l0', allowedPaths: ['a.js', 'b.js'], operation: { type: 'sequence' },
    qualificationPaths: ['drift.json', 'ambiguous.json'], test: { command: 'node accept.js' },
    synthesis: { family: 'pipeline', targets: [{ path: 'a.js' }, { path: 'b.js' }],
      rememberFile: '.huqan/coder/candidates/pipeline.json',
      examples: [-3, -1, 0, 2, 4].map(input => ({ input, expected: input ** 4 })) } };
  const journalFile = path.join(root, 'journal.db');
  const store = openCoderJournal(journalFile); let clock = 0;
  const journal = budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) });
  const repoState = { branch: 'codex/fixture', dirty: false, hasUntracked: false };
  try {
    const denied = runArithmeticSynthesis({ task, root, journal, repoState, authorized: false, runId: 'denied' });
    assert.equal(denied.ok, false);
    assert.equal(fs.existsSync(path.join(root, task.synthesis.rememberFile)), false);
    acceptance('a.js', 'b.js', 999);
    const failed = runArithmeticSynthesis({ task, root, journal, repoState, authorized: true, maxCandidates: 1, runId: 'failed' });
    assert.equal(failed.ok, false);
    assert.equal(failed.attempts[0]?.rolledBack, true);
    assert.equal(fs.existsSync(path.join(root, task.synthesis.rememberFile)), false);
    acceptance('a.js', 'b.js', 625);
    const learned = runArithmeticSynthesis({ task, root, journal, repoState, authorized: true, runId: 'learned' });
    assert.equal(learned.ok, true, JSON.stringify(learned));
    assert.equal(learned.synthesis.memory.ok, true, JSON.stringify(learned.synthesis.memory));
  } finally { store.close(); }
  const memoryPath = path.join(root, task.synthesis.rememberFile);
  const frozen = fs.readFileSync(memoryPath, 'utf8');
  reset(['a.js', 'b.js']);
  fs.mkdirSync(path.join(root, 'src'));
  reset(['src/first.js', 'src/second.cjs']);
  acceptance('src/first.js', 'src/second.cjs', 625);
  const request = structuredClone(task);
  request.allowedPaths = ['src/first.js', 'src/second.cjs'];
  request.synthesis.targets = request.allowedPaths.map(target => ({ path: target }));
  request.synthesis.reuseMemory = true;
  request.synthesis.rememberFile = '.huqan/coder/candidates/unneeded-copy.json';
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\n*.db*\n.huqan/\nstate/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/fixture']); git(['config', 'core.excludesFile', path.join(root, '.git', 'empty-ignore')]);
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, 'state') }; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', path.join(root, 'request.json'),
    '--synthesize', '--authorize', '--root', root, '--journal', journalFile, '--run-id', 'restarted', '--json'],
  { cwd: root, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.ifError(child.error);
  const result = JSON.parse(child.stdout);
  assert.equal(child.status, 0, JSON.stringify(result));
  assert.equal(result.data.synthesis.family, 'pipeline');
  assert.equal(result.data.synthesis.enumerated, 0);
  assert.equal(result.data.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(fs.existsSync(path.join(root, request.synthesis.rememberFile)), false);
  assert.equal(fs.readFileSync(memoryPath, 'utf8'), frozen);
  for (const original of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, original), 'utf8'), baseline);

  reset(request.allowedPaths); acceptance('src/first.js', 'src/second.cjs', 999);
  const reopened = openCoderJournal(journalFile); let ticks = 0;
  const reopenedJournal = budgetExperienceJournal(reopened.journal, { now: () => (ticks += 0.1) });
  try {
    const veto = runArithmeticSynthesis({ root, task: request, journal: reopenedJournal, repoState,
      authorized: true, maxCandidates: 1, runId: 'veto' });
    assert.equal(veto.ok, false);
    assert.equal(veto.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
    assert.equal(veto.attempts[0].rolledBack, true);
    assert.equal(fs.readFileSync(memoryPath, 'utf8'), frozen);
    for (const target of request.allowedPaths) assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), baseline);
    const forged = JSON.parse(frozen); forged.params.steps[0].newText = '0';
    const { hash: unusedHash, ...body } = forged;
    forged.hash = require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
    fs.writeFileSync(memoryPath, JSON.stringify(forged));
    const corrupt = runArithmeticSynthesis({ root, task: request, journal: reopenedJournal, repoState, authorized: true, runId: 'corrupt' });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.attempts.length, 0);
  } finally { reopened.close(); }
});

test('a training-compatible pipeline memory failure charges one attempt before a different fresh search', t => {
  for (const budget of [1, 2]) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pipeline-budget-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const baseline = 'module.exports = x => x + 1;\n';
    const reset = () => { for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), baseline); };
    reset();
    const acceptance = expected => fs.writeFileSync(path.join(root, 'accept.js'),
      `const assert=require('node:assert/strict');assert.equal(require('./b')(require('./a')(2)),${expected});`);
    acceptance(1);
    fs.writeFileSync(path.join(root, 'drift.json'), JSON.stringify({ 'a.js': 'missing', 'b.js': 'missing' }));
    fs.writeFileSync(path.join(root, 'ambiguous.json'), JSON.stringify({ 'a.js': baseline + baseline, 'b.js': baseline }));
    const source = { id: 'source', level: 'l0', allowedPaths: ['a.js', 'b.js'], test: { command: 'node accept.js' },
      operation: { type: 'sequence', steps: [
        { type: 'replace_text', path: 'a.js', find: 'x + 1', replace: '((x - 3) % 3)' },
        { type: 'replace_text', path: 'b.js', find: 'x + 1', replace: '(x * x)' },
      ] } };
    const store = openCoderJournal(path.join(root, 'journal.db')); let clock = 0;
    const journal = budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) });
    const options = { root, journal, authorized: true, repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } };
    try {
      assert.equal(runFixLoop({ ...options, task: source, runId: 'source' }).ok, true);
      const memoryFile = '.huqan/coder/candidates/source.json';
      const saved = rememberCandidate({ task: source, root, journal, runId: 'source:c1', workspaceId: 'default',
        file: memoryFile, qualificationPaths: ['drift.json', 'ambiguous.json'] });
      assert.equal(saved.ok, true, saved.reason);
      const frozen = fs.readFileSync(path.join(root, memoryFile), 'utf8');
      reset(); acceptance(4);
      const target = { ...source, id: 'target', operation: { type: 'sequence' },
        qualificationPaths: ['drift.json', 'ambiguous.json'], synthesis: { family: 'pipeline', reuseMemory: true,
          rememberFile: '.huqan/coder/candidates/fresh.json', targets: [{ path: 'a.js' }, { path: 'b.js' }],
          examples: [-5, -4, -2].map(input => ({ input, expected: (input % 3) ** 2 })) } };
      const result = runArithmeticSynthesis({ ...options, task: target, runId: 'target', maxCandidates: budget });
      assert.equal(result.ok, budget === 2, JSON.stringify(result));
      assert.equal(result.attempts.length, budget);
      assert.equal(result.attempts[0].rolledBack, true);
      assert.equal(fs.readFileSync(path.join(root, memoryFile), 'utf8'), frozen);
      if (budget === 1) {
        assert.equal(result.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
        for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
        assert.equal(fs.existsSync(path.join(root, target.synthesis.rememberFile)), false);
      } else {
        assert.equal(result.attempts[0].stage, 'memory');
        assert.equal(result.attempts[1].stage, 'search');
        assert.equal(result.synthesis.selectedCandidate, 2);
        assert.equal(result.synthesis.memory.ok, true, JSON.stringify(result.synthesis.memory));
        assert.equal(result.synthesis.sourceRunId, 'target:search:c1');
        assert.notDeepEqual(result.synthesis.operation, source.operation);
      }
    } finally { store.close(); }
  }
});
