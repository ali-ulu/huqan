'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { synthesizeArithmetic, runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');

const task = { id: 'synthesis', level: 'l0', allowedPaths: ['src/value.js'],
  operation: { type: 'replace_text', path: 'src/value.js' }, test: { command: 'node test/value.js' },
  synthesis: { family: 'affine-integer', examples: [
    { input: 0, expected: -2 }, { input: 1, expected: 1 }, { input: 3, expected: 7 },
  ] } };

test('synthesizes a new expression from requirements without replacement text or learned method', () => {
  const produced = synthesizeArithmetic({ task, content: 'module.exports = value => value + 1;\n' });
  assert.equal(produced.ok, true);
  assert.equal(produced.task.operation.find, 'value + 1');
  assert.equal(produced.task.operation.replace, '((value * 3) - 2)');
  assert.equal(produced.plan.coefficient, 3);
  assert.equal(produced.plan.offset, -2);
  assert.equal(produced.task.synthesis, undefined);
});

test('production CLI synthesizes, verifies, remembers and reuses a new solution after restart', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-synthesis-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text); };
  write('src/value.js', 'module.exports = n => n + 1;\n');
  write('src/next.js', 'module.exports = fresh => fresh + 1;\n');
  for (const file of ['value', 'next']) write(`test/${file}.js`,
    `const assert = require('node:assert/strict'); const f = require('../src/${file}'); assert.equal(f(5), 13); assert.equal(f(8), 22);\n`);
  write('qualify/drift.md', 'no source expression');
  write('qualify/ambiguous.md', 'n + 1\nn + 1');
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const request = { ...task, qualificationPaths: ['qualify/drift.md', 'qualify/ambiguous.md'],
    synthesis: { ...task.synthesis, rememberFile: '.huqan/coder/candidates/new-solution.json' } };
  write('request.json', JSON.stringify(request));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/synthesis']);
  commit();
  const cli = (args, expectedExit = 0) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'cli.js'),
    'coder', ...args, '--root', root, '--journal', path.join(root, 'journal.db'), '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.throws(() => execFileSync(process.execPath, ['test/value.js'], { cwd: root, stdio: 'pipe' }));
  const denied = cli(['request.json', '--synthesize', '--run-id', 'denied'], 6);
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.data.attempts[0].apply.reason, 'GATE_REFUSED');
  assert.equal(fs.readFileSync(path.join(root, 'src/value.js'), 'utf8'), 'module.exports = n => n + 1;\n');
  const result = cli(['request.json', '--synthesize', '--authorize', '--run-id', 'synthesized']);
  assert.equal(result.data.outcome, 'applied_tested', JSON.stringify(result));
  assert.equal(result.data.synthesis.memory.ok, true);
  assert.equal(result.data.synthesis.coefficient, 3);
  assert.equal(result.data.synthesis.offset, -2);
  assert.equal(result.data.attempts[0].test.ok, true);
  commit();
  write('intent.json', JSON.stringify({ id: 'next', level: 'l0', allowedPaths: ['src/next.js'],
    operation: { type: 'replace_text', path: 'src/next.js' }, test: { command: 'node test/next.js' } }));
  const reused = cli(['intent.json', '--adapt-memory', '--authorize', '--run-id', 'reused']);
  assert.equal(reused.data.record?.observedVerification.ok, true, JSON.stringify(reused));
  const journal = openCoderJournal(path.join(root, 'journal.db'));
  try {
    assert.equal(journal.journal.manifest('synthesized:c1').learningEligibility, 'positive_procedure');
    assert.equal(journal.journal.manifest('reused:c1').learningEligibility, 'positive_procedure');
  } finally { journal.close(); }
});

test('refuses inconsistent, insufficient and unsafe numeric requirements', () => {
  for (const examples of [[], [{ input: 1, expected: 2 }],
    [{ input: 0, expected: 0 }, { input: 1, expected: 1 }, { input: 2, expected: 9 }],
    [{ input: 1, expected: 2 }, { input: 1, expected: 2 }, { input: 1, expected: 2 }],
    [{ input: 0, expected: 0 }, { input: 1, expected: 0.5 }, { input: 2, expected: 1 }],
  ]) {
    const result = synthesizeArithmetic({ task: { ...task, synthesis: { family: 'affine-integer', examples } },
      content: 'module.exports = value => value + 1;' });
    assert.equal(result.ok, false);
  }
});

test('a solution fitting training examples is rolled back when independent verification fails', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-synthesis-rejected-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  const original = 'module.exports = value => value + 1;\n';
  fs.writeFileSync(path.join(root, 'src/value.js'), original);
  fs.writeFileSync(path.join(root, 'test/value.js'),
    "require('node:assert/strict').equal(require('../src/value')(5), 999);\n");
  const store = openCoderJournal(path.join(root, 'journal.db'));
  try {
    const result = runArithmeticSynthesis({ task: { ...task,
      synthesis: { ...task.synthesis, rememberFile: '.huqan/coder/candidates/rejected.json' } },
    root, journal: store.journal, runId: 'failed', authorized: true,
    repoState: { branch: 'feat/synthesis', dirty: false, hasUntracked: false } });
    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].test.ok, false);
    assert.equal(result.attempts[0].rolledBack, true);
    assert.equal(fs.readFileSync(path.join(root, 'src/value.js'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(root, '.huqan/coder/candidates/rejected.json')), false);
    assert.equal(store.journal.manifest('failed:c1').learningEligibility, 'negative_example');
  } finally { store.close(); }
});

test('refuses target code outside the complete supported module grammar and missing authority bounds', () => {
  for (const content of ['module.exports = value => sideEffect(value);',
    'module.exports = class => class + 1;', '"use strict"; module.exports = eval => eval + 1;',
    '"use strict"; module.exports = arguments => arguments + 1;', 'module.exports = x\n=> x + 1;',
    'module.exports = value => value + other;', 'module.exports = value => !value + 1;',
    'module.exports = value => value + 010;', 'module.exports = value => value + 1; sideEffect();']) {
    assert.equal(synthesizeArithmetic({ task, content }).ok, false, content);
  }
  assert.equal(synthesizeArithmetic({ task: { ...task, test: undefined }, content: 'module.exports = value => value + 1;' }).ok, false);
  assert.equal(synthesizeArithmetic({ task: { ...task, allowedPaths: [] }, content: 'module.exports = value => value + 1;' }).ok, false);
});
