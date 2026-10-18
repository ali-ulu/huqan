'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceArithmeticRepair, runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const text = 'function clean(value) { return value.toUpperCase(); }\nmodule.exports = clean;\n';
function fixture(t, count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-synthesis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targets = Array.from({ length: count }, (_, at) => {
    const file = `${at}.js`; fs.writeFileSync(path.join(root, file), text);
    return { path: file, family: 'string-expression', functionName: 'clean', examples: [
      { input: ' ABC ', expected: 'abc' }, { input: ' MiXeD ', expected: 'mixed' }, { input: '', expected: '' },
    ] };
  });
  return { root, task: { id: 'mixed', level: 'l0', allowedPaths: targets.map(target => target.path),
    operation: { type: 'sequence' }, test: { command: 'node acceptance.js' },
    synthesis: { family: 'multi-target', searchMode: 'bounded', targets } } };
}
test('bounded mixed search discloses full child enumeration and omitted joint space', t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.root, '1.js'), 'module.exports = x => x + 1;\n');
  options.task.synthesis.targets[1] = { path: '1.js', family: 'arithmetic-expression',
    examples: [-3, -1, 0, 2, 5].map(input => ({ input, expected: input * input })) };
  const result = produceArithmeticRepair(options);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.task.candidates.length, 8);
  assert.equal(result.plan.targets[0].enumerated, 1885);
  assert.equal(result.plan.targets[0].matchingPrograms, 14);
  assert.equal(result.plan.targets[0].omittedCandidates, 6);
  assert.equal(result.plan.totalCandidateCombinations, 42);
  assert.equal(result.plan.retainedCandidateCombinations, 8);
  assert.equal(result.plan.omittedCandidateCombinations, 34);
  assert.equal(result.plan.searchComplete, false);
  assert.equal(result.task.candidates[1].steps[0].replace, result.task.candidates[0].steps[0].replace);
  assert.notEqual(result.task.candidates[1].steps[1].replace, result.task.candidates[0].steps[1].replace);
  const changedTest = structuredClone(options.task); changedTest.test.command = 'node unseen-holdout.js';
  assert.deepEqual(produceArithmeticRepair({ ...options, task: changedTest }).task.candidates, result.task.candidates);
  const limited = runArithmeticSynthesis({ ...options, maxCandidates: 2, dryRun: true });
  assert.equal(limited.synthesis.retainedCandidateCombinations, 2);
  assert.equal(limited.synthesis.omittedCandidateCombinations, 40);
  delete options.task.synthesis.searchMode;
  assert.equal(produceArithmeticRepair(options).reason, 'SYNTHESIS_MULTI_TARGET_OVER_CAP');
});
test('eight ambiguous targets retain eight deterministic proposals without expanding Cartesian space', t => {
  const options = fixture(t, 8);
  const a = produceArithmeticRepair(options), b = produceArithmeticRepair(options);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.plan.totalCandidateCombinations, 14 ** 8);
  assert.equal(a.task.candidates.length, 8);
  assert.equal(new Set(a.plan.targets[0].candidates.map(candidate => JSON.stringify(candidate.program))).size, 8);
  assert.deepEqual(a.task.candidates, b.task.candidates);
});
test('large unseen Cartesian counts are exact decimal strings', t => {
  const options = fixture(t, 8);
  for (const target of options.task.synthesis.targets)
    target.examples = ['a', 'b', 'c'].map(input => ({ input, expected: '' }));
  const result = produceArithmeticRepair(options);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.plan.targets[0].matchingPrograms, 1065);
  assert.equal(result.plan.totalCandidateCombinations, '1654995671290405437890625');
  assert.equal(result.plan.omittedCandidateCombinations, '1654995671290405437890617');
  assert.equal(result.plan.retainedCandidateCombinations, 8);
  assert.equal(result.plan.searchComplete, false);
});
test('mixed memory requires a journal and invalid search modes fail closed', t => {
  for (const flag of [{ reuseMemory: true }, { rememberFile: 'method.json' }]) {
    const options = fixture(t); Object.assign(options.task.synthesis, flag);
    assert.equal(runArithmeticSynthesis(options).reason, 'SYNTHESIS_MEMORY_REQUIRES_JOURNAL');
    assert.equal(produceArithmeticRepair(options).ok, true);
  }
  const options = fixture(t); options.task.synthesis.searchMode = 'guess';
  assert.equal(produceArithmeticRepair(options).reason, 'SYNTHESIS_MULTI_TARGET_INVALID');
});

test('native CLI gates and verifies mixed string and numeric files and rolls both back on failed acceptance', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-native-multi-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const acceptance of ['pass', 'fail']) {
    const root = path.join(base, acceptance); fs.mkdirSync(root);
    const baseline = 'module.exports = x => x + 1;\n';
    fs.writeFileSync(path.join(root, 'a.js'), text);
    fs.writeFileSync(path.join(root, 'b.js'), baseline);
    fs.writeFileSync(path.join(root, 'accept.js'), `const assert=require('node:assert/strict');
      const a=require('./a'),b=require('./b');assert.equal(a(" ÄBC "),"äbc");assert.equal(a(" OTHER "),"other");
      assert.equal(b(5),15);assert.equal(b(8),${acceptance === 'pass' ? 21 : 999});`);
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-qb', 'codex/fixture']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const request = { id: 'native-multi', level: 'l0', allowedPaths: ['a.js', 'b.js'],
      operation: { type: 'sequence' }, test: { command: 'node accept.js' },
      synthesis: { family: 'multi-target', searchMode: 'bounded', targets: [
        { path: 'a.js', family: 'string-expression', functionName: 'clean', examples: [
          { input: ' ABC ', expected: 'abc' }, { input: ' MiXeD ', expected: 'mixed' }, { input: '', expected: '' },
        ] },
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
      for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name === 'a.js' ? text : baseline);
    }
    const result = run(true);
    if (acceptance === 'pass') {
      assert.equal(result.data.outcome, 'applied_tested');
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      assert.equal(result.data.synthesis.candidateCombinations, 8);
    } else {
      assert.equal(result.data.attempts.length, 8);
      assert.ok(result.data.attempts.every(attempt => attempt.rolledBack === true && attempt.test.exitCode === 1));
      for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name === 'a.js' ? text : baseline);
    }
  }
});
