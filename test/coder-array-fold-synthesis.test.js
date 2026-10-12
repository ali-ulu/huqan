'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { synthesizeArithmetic } = require('../lib/coder/arithmetic-synthesis');
const { readArrayFoldTarget } = require('../lib/experience/array-fold-program');

test('array-fold synthesis can repair an invalid baseline evaluation', () => {
  const task = { allowedPaths: ['src/fold.js'], operation: { type: 'replace_text', path: 'src/fold.js' },
    test: { command: 'node test/fold.js' }, synthesis: { family: 'array-fold', functionName: 'fold',
      examples: [{ input: [], expected: 0 }, { input: [0], expected: 0 }, { input: [1], expected: 1 },
        { input: [1, 2], expected: 3 }] } };
  const content = 'function fold(xs) { let acc = 0; for (const item of xs) { acc = (acc % item); } return acc; }';
  const result = synthesizeArithmetic({ task, content });
  assert.equal(result.ok, true);
  assert.equal(result.plan.baselineMatches, 1);
  const repaired = readArrayFoldTarget(result.task.operation.replace, { functionName: 'fold' });
  assert.equal(repaired.evaluate([0, 2, 3]), 5);
});

test('production CLI discovers a loop from list observations and reuses it after restart', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-array-fold-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const original = (name, parameter) => `'use strict';\nfunction helper(x) { return x + 1; }\n`
    + `function ${name}(${parameter}) { /* keep project context */ return 0; }\n`
    + `module.exports = { calculate: ${name}, helper };\n`;
  for (const [file, name, parameter] of [['train', 'total', 'values'], ['transfer', 'calculate', 'items'],
    ['reject', 'another', 'entries'], ['changed', 'aggregate', 'numbers'], ['changedTransfer', 'combine', 'rows'],
    ['broken', 'repair', 'values'], ['brokenTransfer', 'restore', 'items']]) {
    const sumTask = file.startsWith('changed') || file.startsWith('broken');
    const content = original(name, parameter);
    write(`src/${file}.js`, file.startsWith('broken')
      ? content.replace('/* keep project context */ return 0;',
        `let acc = 0; for (const item of ${parameter}) { acc = (acc % item); } return acc;`) : content);
    write(`test/${file}.js`, `const assert = require('node:assert/strict');\n`
      + `const api = require('../src/${file}');\nassert.equal(api.helper(5), 6);\n`
      + `const input = [4, -3, 8];\nassert.equal(api.calculate(input), ${sumTask ? 9 : file === 'reject' ? 99 : 89});\n`
      + `assert.deepEqual(input, [4, -3, 8]);\nassert.equal(api.calculate([]), 0);\n`
      + `assert.equal(api.calculate([7]), ${sumTask ? 7 : 49});\n`);
  }
  const trainingFunction = readArrayFoldTarget(original('total', 'values'), { functionName: 'total' }).find;
  write('qualify/drift.md', 'no matching function');
  write('qualify/ambiguous.md', `${trainingFunction}\n${trainingFunction}`);
  const changedFunction = readArrayFoldTarget(original('aggregate', 'numbers'), { functionName: 'aggregate' }).find;
  write('qualify/sum-ambiguous.md', `${changedFunction}\n${changedFunction}`);
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/array-fold']); commit();
  const request = (file, functionName) => ({ id: file, level: 'l0', allowedPaths: [`src/${file}.js`],
    operation: { type: 'replace_text', path: `src/${file}.js` }, test: { command: `node test/${file}.js` },
    synthesis: { family: 'array-fold', functionName, reuseMemory: true,
      examples: [{ input: [], expected: 0 }, { input: [2], expected: 4 },
        { input: [1, 3], expected: 10 }, { input: [-2, 5, 1], expected: 30 }] } });
  const cli = (task, expectedExit = 0) => {
    const file = path.join(root, `${task.id}.json`); fs.writeFileSync(file, JSON.stringify(task));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file,
      '--root', root, '--journal', path.join(root, 'journal.db'), '--run-id', task.id,
      '--synthesize', '--authorize', '--json'], { encoding: 'utf8', cwd: root, timeout: 120000,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') } });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, expectedExit === 0 ? 'completed' : 'blocked');
    return response.data;
  };
  const training = request('train', 'total');
  training.qualificationPaths = ['qualify/drift.md', 'qualify/ambiguous.md'];
  training.synthesis.rememberFile = '.huqan/coder/candidates/fold.json';
  const trained = cli(training);
  assert.equal(trained.outcome, 'applied_tested', JSON.stringify(trained));
  assert.equal(trained.synthesis.memory.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'src/train.js'), 'utf8'), /for\s*\(/u);
  const sealed = fs.readFileSync(path.join(root, training.synthesis.rememberFile), 'utf8');
  commit();
  const transferred = cli(request('transfer', 'calculate'));
  assert.equal(transferred.outcome, 'applied_tested', JSON.stringify(transferred));
  assert.equal(transferred.synthesis.memoryReuse.attempted, true);
  assert.equal(transferred.synthesis.enumerated, 0);
  assert.equal(transferred.attempts.length, 1);
  assert.equal(fs.readFileSync(path.join(root, training.synthesis.rememberFile), 'utf8'), sealed);
  commit();
  const changed = request('changed', 'aggregate');
  changed.qualificationPaths = ['qualify/drift.md', 'qualify/sum-ambiguous.md'];
  // Training observations cannot distinguish sum from sum-of-squares. Only
  // the independent test rejects the old method; its rollback must precede search.
  changed.synthesis.examples = [{ input: [], expected: 0 }, { input: [1], expected: 1 },
    { input: [0, 1], expected: 1 }];
  changed.synthesis.rememberFile = '.huqan/coder/candidates/sum.json';
  const learned = cli(changed);
  assert.equal(learned.outcome, 'applied_tested', JSON.stringify(learned));
  assert.equal(learned.synthesis.memoryReuse.outcome, 'rolled_back');
  assert.equal(learned.synthesis.memoryReuse.fallback, true);
  assert.equal(learned.attempts[0].stage, 'memory');
  assert.equal(learned.attempts[0].rolledBack, true);
  assert.equal(learned.attempts.at(-1).stage, 'search');
  assert.equal(learned.synthesis.memory.ok, true);
  assert.ok(learned.attempts.length <= 8);
  commit();
  const next = request('changedTransfer', 'combine');
  next.synthesis.examples = [{ input: [], expected: 0 }, { input: [3], expected: 3 },
    { input: [-2, 4], expected: 2 }];
  const reused = cli(next);
  assert.equal(reused.outcome, 'applied_tested', JSON.stringify(reused));
  assert.equal(reused.synthesis.memoryReuse.attempted, true);
  assert.equal(reused.synthesis.enumerated, 0);
  assert.equal(reused.attempts.length, 1);
  assert.equal(fs.readFileSync(path.join(root, training.synthesis.rememberFile), 'utf8'), sealed);
  commit();
  const broken = request('broken', 'repair');
  broken.synthesis.examples = [{ input: [], expected: 0 }, { input: [0], expected: 0 },
    { input: [1, 2], expected: 3 }, { input: [-2, 4], expected: 2 }];
  broken.synthesis.rememberFile = '.huqan/coder/candidates/repaired-loop.json';
  const brokenSource = fs.readFileSync(path.join(root, 'src/broken.js'), 'utf8');
  const brokenFunction = readArrayFoldTarget(brokenSource, { functionName: 'repair' }).find;
  write('qualify/broken-ambiguous.md', `${brokenFunction}\n${brokenFunction}`);
  broken.qualificationPaths = ['qualify/drift.md', 'qualify/broken-ambiguous.md'];
  commit();
  const repaired = cli(broken);
  assert.equal(repaired.outcome, 'applied_tested', JSON.stringify(repaired));
  assert.equal(repaired.synthesis.baselineMatches, 1);
  assert.equal(repaired.synthesis.memory.ok, true);
  assert.equal(repaired.attempts.some(attempt => attempt.kept === true), true);
  assert.notEqual(fs.readFileSync(path.join(root, 'src/broken.js'), 'utf8'), brokenSource);
  const repairedSeal = fs.readFileSync(path.join(root, broken.synthesis.rememberFile), 'utf8');
  commit();
  const brokenTransfer = request('brokenTransfer', 'restore');
  brokenTransfer.synthesis.examples = broken.synthesis.examples;
  const repairedAgain = cli(brokenTransfer);
  assert.equal(repairedAgain.outcome, 'applied_tested', JSON.stringify(repairedAgain));
  assert.equal(repairedAgain.synthesis.memoryReuse.attempted, true);
  assert.equal(repairedAgain.synthesis.enumerated, 0);
  assert.equal(repairedAgain.attempts.length, 1);
  assert.equal(fs.readFileSync(path.join(root, broken.synthesis.rememberFile), 'utf8'), repairedSeal);
  commit();
  const rejected = cli(request('reject', 'another'), 6);
  assert.equal(rejected.outcome, 'needs_human_decision');
  assert.equal(rejected.synthesis.memoryReuse.outcome, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(root, 'src/reject.js'), 'utf8'), original('another', 'entries'));
  assert.equal(rejected.attempts.every(attempt => attempt.rolledBack === true), true);
});
