'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { produceArithmeticRepair } = require('../lib/coder/arithmetic-synthesis');
const { runTask, STATUS } = require('../lib/deterministic-task-runner');
const { execFileSync, spawnSync } = require('node:child_process');

test('synthesizes two independent targets as one bounded sequence without replacement text', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-multi-synthesis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'a.js': 'module.exports = x => x + 1;\n', 'b.js': 'module.exports = x => x + 1;\n' };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  const task = { id: 'multi', level: 'l0', allowedPaths: Object.keys(files), operation: { type: 'sequence' },
    test: { command: 'node --test' }, synthesis: { family: 'multi-target', targets: [
      { path: 'a.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 3 - 2 })) },
      { path: 'b.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 2 + 5 })) },
    ] } };
  const produced = produceArithmeticRepair({ task, root });
  assert.equal(produced.ok, true, produced.reason);
  assert.equal(produced.task.operation.type, 'sequence');
  const transformed = runTask({ ...produced.task, files });
  assert.equal(transformed.status, STATUS.COMPLETED);
  assert.equal(transformed.patch.length, 2);
  assert.match(transformed.files['a.js'], /x \* 3/);
  assert.match(transformed.files['b.js'], /x \* 2/);
  const broken = structuredClone(produced.task);
  broken.operation.steps[1].find = 'missing';
  assert.deepEqual(runTask({ ...broken, files }).files, files);
  for (const [file, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), text);
  for (const mutate of [
    request => { request.synthesis.targets[1].path = 'a.js'; },
    request => { request.synthesis.targets[1].path = '../outside.js'; },
    request => { request.synthesis.rememberFile = 'record.json'; },
    request => { request.operation.steps = []; },
  ]) {
    const invalid = structuredClone(task); mutate(invalid);
    assert.equal(produceArithmeticRepair({ task: invalid, root }).ok, false);
  }
  const expressions = structuredClone(task);
  expressions.synthesis.targets[0] = { path: 'a.js', family: 'arithmetic-expression',
    examples: [-3, -1, 0, 2, 5].map(input => ({ input, expected: input * input })) };
  const alternatives = produceArithmeticRepair({ task: expressions, root });
  assert.equal(alternatives.ok, true, alternatives.reason);
  assert.equal(alternatives.plan.candidateCombinations, 3);
  assert.equal(alternatives.task.candidates.length, 3);
  for (const candidate of alternatives.task.candidates) {
    const result = runTask({ ...alternatives.task, operation: candidate, files });
    assert.equal(result.status, STATUS.COMPLETED);
    assert.equal(result.patch.length, 2);
  }
  expressions.synthesis.targets[1] = { ...structuredClone(expressions.synthesis.targets[0]), path: 'b.js' };
  assert.equal(produceArithmeticRepair({ task: expressions, root }).reason, 'SYNTHESIS_MULTI_TARGET_OVER_CAP');
  fs.writeFileSync(path.join(root, 'b.js'),
    'function fold(xs) { let acc = 0; for (const item of xs) { acc = (acc % item); } return acc; }');
  const ambiguous = structuredClone(task);
  ambiguous.synthesis.targets[1] = { path: 'b.js', family: 'array-fold', functionName: 'fold',
    examples: [{ input: [], expected: 0 }, { input: [1], expected: 1 }, { input: [2], expected: 2 }] };
  assert.equal(produceArithmeticRepair({ task: ambiguous, root }).reason, 'SYNTHESIS_MULTI_TARGET_OVER_CAP');
});

test('native CLI gates and verifies both synthesized files and rolls both back on failed acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-native-multi-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const acceptance of ['pass', 'fail']) {
    const root = path.join(base, acceptance); fs.mkdirSync(root);
    const baseline = 'module.exports = x => x + 1;\n';
    for (const file of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, file), baseline);
    fs.writeFileSync(path.join(root, 'accept.js'), `const assert=require('node:assert/strict');
      const a=require('./a'),b=require('./b');assert.equal(a(5),13);assert.equal(a(8),22);
      assert.equal(b(5),15);assert.equal(b(8),${acceptance === 'pass' ? 21 : 999});`);
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-qb', 'codex/fixture']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const request = { id: 'native-multi', level: 'l0', allowedPaths: ['a.js', 'b.js'],
      operation: { type: 'sequence' }, test: { command: 'node accept.js' },
      synthesis: { family: 'multi-target', targets: [
        { path: 'a.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 3 - 2 })) },
        { path: 'b.js', family: 'affine-integer', examples: [0, 1, 3].map(input => ({ input, expected: input * 2 + 5 })) },
      ] } };
    const file = path.join(base, `${acceptance}.json`); fs.writeFileSync(file, JSON.stringify(request));
    const run = authorized => {
      const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file,
        '--synthesize', '--root', root, '--json', ...(authorized ? ['--authorize'] : [])],
      { cwd: base, encoding: 'utf8', timeout: 120000, windowsHide: true, env });
      assert.ifError(child.error); assert.equal(child.signal, null);
      const result = JSON.parse(child.stdout);
      assert.equal(child.status, authorized && acceptance === 'pass' ? 0 : 6, JSON.stringify(result));
      return result;
    };
    if (acceptance === 'pass') {
      run(false);
      for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
    }
    const result = run(true);
    if (acceptance === 'pass') {
      assert.equal(result.data.outcome, 'applied_tested');
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      assert.equal(result.data.synthesis.candidateCombinations, 1);
    } else {
      assert.equal(result.data.attempts[0].rolledBack, true);
      for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
    }
  }
});
