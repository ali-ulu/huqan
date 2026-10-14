'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { runArithmeticSynthesis, formatSynthesisText } = require('../lib/coder/arithmetic-synthesis');
const { openCoderJournal } = require('../lib/coder/journal-store');

test('one production mode reuses memory, verifies rollback before synthesis, and preserves the shared budget', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-first-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text); };
  const original = name => `module.exports = ${name} => ${name === 'wrapped' ? '(wrapped + 1)' : `${name} + 1`};\n`;
  for (const name of ['train', 'repair', 'wrapped', 'denied', 'limited', 'timeout', 'capped', 'reuse', 'dollars', 'curve', 'ambiguous', 'corrupt']) {
    write(`src/${name}.js`, original(name));
    const expected = name === 'train' ? [0, 0] : name === 'curve' ? [26, 65] : [1, 0];
    write(`test/${name}.js`, `const assert = require('node:assert/strict'); const f = require('../src/${name}');
assert.equal(f(5), ${expected[0]}); assert.equal(f(8), ${expected[1]});\n`);
  }
  write('src/dollars.js', original('$$'));
  write('qualify/drift.md', 'no matching expression');
  write('qualify/ambiguous.md', 'train + 1\ntrain + 1');
  write('qualify/repair-ambiguous.md', 'repair + 1\nrepair + 1');
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/memory-first']); commit();
  const task = name => ({ id: name, level: 'l0', allowedPaths: [`src/${name}.js`],
    operation: { type: 'replace_text', path: `src/${name}.js` }, test: { command: `node test/${name}.js` },
    synthesis: { family: 'arithmetic-expression', reuseMemory: true,
      examples: [0, 2, 4].map(input => ({ input, expected: 0 })) } });
  const cli = (request, args = ['--authorize'], expectedStatus = 0) => {
    write('request.json', JSON.stringify(request));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'cli.js'),
      'coder', 'request.json', '--synthesize', ...args, '--root', root,
      '--journal', path.join(root, 'journal.db'), '--run-id', request.id, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
    return JSON.parse(child.stdout).data;
  };
  const trainingTask = task('train');
  trainingTask.qualificationPaths = ['qualify/drift.md', 'qualify/ambiguous.md'];
  trainingTask.synthesis.rememberFile = '.huqan/coder/candidates/zeros.json';
  const preview = cli({ ...trainingTask, id: 'preview' }, ['--authorize', '--dry-run'], 6);
  assert.equal(preview.synthesis.memoryReuse.reason, 'dry_run');
  assert.equal(preview.synthesis.memory, null);
  assert.equal(fs.existsSync(path.join(root, '.huqan/coder/candidates/zeros.json')), false);
  const training = cli(trainingTask);
  assert.equal(training.outcome, 'applied_tested', JSON.stringify(training));
  assert.equal(training.synthesis.memory.ok, true, JSON.stringify(training.synthesis.memory));
  assert.equal(training.synthesis.operation.replace, '0');
  assert.equal(training.synthesis.memoryReuse.reason, 'no_applicable_candidate');
  commit();
  const wrapped = cli(task('wrapped'));
  assert.equal(wrapped.outcome, 'applied_tested', JSON.stringify(wrapped));
  assert.equal(wrapped.synthesis.excludedCandidates, 1);
  assert.equal(wrapped.attempts.length, 4);
  commit();
  const denied = cli(task('denied'), [], 6);
  assert.equal(denied.attempts.length, 1);
  assert.equal(denied.attempts[0].apply.reason, 'GATE_REFUSED');
  assert.equal(denied.synthesis.memoryReuse.fallback, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'src/denied.js'), 'utf8'), original('denied'));
  const store = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const unavailable = runArithmeticSynthesis({ task: task('limited'), root, journal: store.journal,
      runId: 'unavailable', authorized: true, spawn: () => { throw new Error('missing executable'); },
      repoState: { branch: 'feat/memory-first', dirty: false, hasUntracked: false } });
    assert.equal(unavailable.attempts.length, 1);
    assert.equal(unavailable.attempts[0].test.reason, 'TEST_SPAWN_FAILED');
    assert.equal(unavailable.synthesis.memoryReuse.fallback, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'src/limited.js'), 'utf8'), original('limited'));
    for (const [name, code, reason] of [['timeout', 'ETIMEDOUT', 'TEST_TIMEOUT'], ['capped', 'ENOBUFS', 'OUTPUT_LIMIT_EXCEEDED']]) {
      const interrupted = runArithmeticSynthesis({ task: task(name), root, journal: store.journal,
        runId: code, authorized: true, spawn: () => ({ status: 1, error: { code }, stdout: '', stderr: '' }),
        repoState: { branch: 'feat/memory-first', dirty: false, hasUntracked: false } });
      assert.equal(interrupted.attempts.length, 1);
      assert.equal(interrupted.attempts[0].test.reason, reason);
      assert.equal(interrupted.synthesis.memoryReuse.fallback, undefined);
      assert.equal(fs.readFileSync(path.join(root, `src/${name}.js`), 'utf8'), original(name));
    }
    const limited = runArithmeticSynthesis({ task: task('limited'), root, journal: store.journal,
      runId: 'limited', authorized: true, maxCandidates: 1,
      repoState: { branch: 'feat/memory-first', dirty: false, hasUntracked: false } });
    assert.equal(limited.reason, 'SYNTHESIS_BUDGET_EXHAUSTED', JSON.stringify(limited));
    assert.equal(limited.attempts.length, 1);
    assert.equal(limited.attempts[0].rolledBack, true);
    assert.equal(fs.readFileSync(path.join(root, 'src/limited.js'), 'utf8'), original('limited'));
  } finally { store.close(); }
  const repairTask = task('repair');
  repairTask.qualificationPaths = ['qualify/drift.md', 'qualify/repair-ambiguous.md'];
  repairTask.synthesis.rememberFile = '.huqan/coder/candidates/parity.json';
  const repaired = cli(repairTask);
  assert.equal(repaired.outcome, 'applied_tested', JSON.stringify(repaired));
  assert.equal(repaired.synthesis.memoryReuse.fallback, true);
  assert.equal(repaired.attempts[0].stage, 'memory');
  assert.equal(repaired.attempts[0].test.ok, false);
  assert.equal(repaired.attempts[0].rolledBack, true);
  assert.ok(repaired.attempts.length <= 8);
  assert.equal(repaired.synthesis.selectedCandidate, repaired.attempts.length);
  assert.equal(repaired.synthesis.excludedCandidates, 1);
  assert.equal(repaired.synthesis.memory.ok, true);
  const parity = JSON.parse(fs.readFileSync(path.join(root, '.huqan/coder/candidates/parity.json'), 'utf8'));
  assert.equal(parity.runId, repaired.synthesis.sourceRunId);
  assert.equal(parity.params.newText, '(repair % 2)');
  commit();
  const reuseTask = task('reuse');
  const parityBytes = fs.readFileSync(path.join(root, '.huqan/coder/candidates/parity.json'), 'utf8');
  reuseTask.synthesis.rememberFile = '.huqan/coder/candidates/reused-copy.json';
  reuseTask.synthesis.examples = [0, 1, 2].map(input => ({ input, expected: input % 2 }));
  const reused = cli(reuseTask);
  assert.equal(reused.outcome, 'applied_tested', JSON.stringify(reused));
  assert.equal(reused.synthesis.memoryReuse.outcome, 'applied_tested');
  assert.equal(reused.synthesis.enumerated, 0);
  assert.equal(reused.attempts.length, 1);
  assert.equal(reused.synthesis.sourceRunId, 'reuse:memory:c1');
  assert.equal(reused.synthesis.memory.ok, true);
  assert.equal(reused.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(path.resolve(root, reused.synthesis.memory.selectedFile), path.join(root, '.huqan/coder/candidates/parity.json'));
  assert.equal(fs.existsSync(path.join(root, reuseTask.synthesis.rememberFile)), false);
  assert.equal(fs.readFileSync(path.join(root, '.huqan/coder/candidates/parity.json'), 'utf8'), parityBytes);
  const reuseText = formatSynthesisText(reused, { known: true });
  assert.match(reuseText, /Memory: reused /u);
  assert.doesNotMatch(reuseText, /Memory: (?:refused|remembered)/u);
  commit();
  const dollarsTask = task('dollars');
  dollarsTask.synthesis.examples = reuseTask.synthesis.examples;
  const dollars = cli(dollarsTask);
  assert.equal(dollars.outcome, 'applied_tested', JSON.stringify(dollars));
  assert.equal(dollars.synthesis.memoryReuse.outcome, 'applied_tested');
  assert.equal(dollars.synthesis.operation.replace, '($$ % 2)');
  commit();
  const curveTask = task('curve');
  curveTask.synthesis.examples = [0, 1, 2].map(input => ({ input, expected: input * input + 1 }));
  const curve = cli(curveTask);
  assert.equal(curve.outcome, 'applied_tested', JSON.stringify(curve));
  assert.equal(curve.synthesis.memoryReuse.attempted, false);
  assert.equal(curve.synthesis.operation.replace, '((curve * curve) + 1)');
  commit();
  const ambiguous = cli(task('ambiguous'), ['--authorize'], 6);
  assert.equal(ambiguous.reason, 'candidate_selection_ambiguous');
  assert.equal(ambiguous.attempts.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'src/ambiguous.js'), 'utf8'), original('ambiguous'));
  const journal = openCoderJournal(path.join(root, 'journal.db'));
  try {
    assert.equal(journal.journal.manifest('repair:memory:c1').learningEligibility, 'negative_example');
    assert.equal(journal.journal.manifest(repaired.synthesis.sourceRunId).learningEligibility, 'positive_procedure');
    assert.equal(journal.journal.manifest('reuse:memory:c1').learningEligibility, 'positive_procedure');
  } finally { journal.close(); }
  const zerosFile = path.join(root, '.huqan/coder/candidates/zeros.json');
  const zeros = JSON.parse(fs.readFileSync(zerosFile, 'utf8'));
  zeros.params.newText = '999';
  fs.writeFileSync(zerosFile, JSON.stringify(zeros));
  const corruptTask = task('corrupt');
  corruptTask.synthesis.examples = reuseTask.synthesis.examples;
  const corrupt = cli(corruptTask, ['--authorize'], 6);
  assert.equal(corrupt.reason, 'source_procedure_mismatch');
  assert.equal(corrupt.attempts.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'src/corrupt.js'), 'utf8'), original('corrupt'));
});
