'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { produceArithmeticRepair } = require('../lib/coder/arithmetic-synthesis');
const { producePipelineRepair } = require('../lib/coder/pipeline-synthesis');
const { searchExpressions } = require('../lib/coder/expression-search');

const baseline = 'module.exports = x => x + 1;\n';
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pipeline-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), baseline);
  const task = { id: 'pipeline', level: 'l0', allowedPaths: ['a.js', 'b.js'], operation: { type: 'sequence' },
    test: { command: 'node accept.js' }, synthesis: { family: 'pipeline', targets: [{ path: 'a.js' }, { path: 'b.js' }],
      examples: [-3, -1, 0, 2, 4].map(input => ({ input, expected: input ** 4 })) } };
  return { root, task };
}

test('joint pipeline search learns x^4 without intermediate examples or supplied replacements', t => {
  const { root, task } = fixture(t);
  assert.equal(searchExpressions({ parameter: 'x', examples: task.synthesis.examples }).candidates.length, 0);
  const produced = produceArithmeticRepair({ root, task });
  assert.equal(produced.ok, true, produced.reason);
  assert.equal(produced.plan.composition, 'second(first(input))');
  assert.ok(produced.plan.evaluatedPairs <= produced.plan.pairBudget);
  assert.ok(produced.plan.stageEnumerated.every(count => count <= produced.plan.stageSearchBudget));
  assert.equal(produced.plan.enumerated,
    produced.plan.evaluatedPairs + produced.plan.stageEnumerated.reduce((sum, count) => sum + count, 0));
  assert.ok(produced.plan.enumerated <= produced.plan.searchBudget);
  assert.ok(produced.plan.matchingPairs >= produced.task.candidates.length);
  assert.equal(produced.plan.omittedCandidates, produced.plan.matchingPairs - produced.task.candidates.length);
  assert.equal(produced.task.candidates.length, 8);
  assert.deepEqual(produced.task.operation.steps.map(step => step.replace), ['(x * x)', '(x * x)']);
  for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
});

test('pipeline refuses malformed authority, undeclared or duplicate paths and intermediate labels', t => {
  const { root, task } = fixture(t);
  for (const mutate of [
    value => { value.synthesis.targets[1].path = 'a.js'; },
    value => { value.allowedPaths = ['a.js']; },
    value => { value.operation.steps = []; },
    value => { value.synthesis.targets[0].examples = []; },
    value => { value.synthesis.rememberFile = 'candidate.json'; },
    value => { value.synthesis.targets[0].path = '../outside.js'; },
    value => { value.synthesis.targets[1].path = './a.js'; value.allowedPaths.push('./a.js'); },
    value => { value.synthesis.targets[0].functionName = 'x()'; },
    value => { value.test.command = ''; },
  ]) {
    const copy = structuredClone(task); mutate(copy);
    assert.equal(producePipelineRepair({ task: copy, root }).ok, false);
  }
  const sparse = structuredClone(task); delete sparse.synthesis.examples[1];
  assert.equal(producePipelineRepair({ task: sparse, root }).ok, false);
  const duplicate = structuredClone(task); duplicate.synthesis.examples[1] = duplicate.synthesis.examples[0];
  assert.equal(producePipelineRepair({ task: duplicate, root }).reason, 'SYNTHESIS_EXAMPLES_INVALID');
  const accessor = structuredClone(task);
  Object.defineProperty(accessor.synthesis.targets[0], 'path', { get() { throw new Error('getter executed'); }, enumerable: true });
  assert.equal(producePipelineRepair({ task: accessor, root }).ok, false);
  fs.linkSync(path.join(root, 'a.js'), path.join(root, 'alias.js'));
  const alias = structuredClone(task);
  alias.allowedPaths.push('alias.js'); alias.synthesis.targets[1].path = 'alias.js';
  assert.equal(producePipelineRepair({ task: alias, root }).reason, 'SYNTHESIS_PIPELINE_INVALID');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = x => require("fs").readFileSync(x);');
  assert.equal(producePipelineRepair({ task, root }).reason, 'SYNTHESIS_TARGET_UNSUPPORTED');
});

test('pipeline keeps distinct inode identities above the safe Number range', t => {
  const { root, task } = fixture(t);
  const originalStat = fs.statSync;
  fs.statSync = (file, options) => {
    const stat = originalStat(file, options);
    const at = ['a.js', 'b.js'].indexOf(path.basename(String(file)));
    if (at !== -1) {
      const inode = 9007199254740992n + BigInt(at);
      stat.dev = options?.bigint ? 1n : 1;
      stat.ino = options?.bigint ? inode : Number(inode);
    }
    return stat;
  };
  try {
    const produced = producePipelineRepair({ task, root });
    assert.equal(produced.ok, true, produced.reason);
  } finally { fs.statSync = originalStat; }
});

test('pipeline recognizes an already satisfied composition', t => {
  const { root, task } = fixture(t);
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), 'module.exports = x => x * x;');
  assert.equal(producePipelineRepair({ root, task }).reason, 'SYNTHESIS_ALREADY_SATISFIED');
});

test('native pipeline applies only with authority and restores both files on failed independent acceptance', t => {
  for (const acceptance of ['pass', 'fail']) {
    const { root, task } = fixture(t);
    fs.writeFileSync(path.join(root, 'accept.js'), `const assert=require('node:assert/strict');
      const a=require('./a'),b=require('./b'); assert.equal(b(a(5)),${acceptance === 'pass' ? 625 : 999});
      assert.equal(b(a(-2)),16);`);
    fs.writeFileSync(path.join(root, '.gitignore'), 'request.json\nstate/\nmemory.db\nmemory.db-shm\nmemory.db-wal\n');
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-qb', 'codex/fixture']);
    // Do not let a developer's global ignore hide an untracked fixture input.
    git(['config', 'core.excludesFile', path.join(root, '.git', 'empty-global-excludes')]);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const requestFile = path.join(root, 'request.json'); fs.writeFileSync(requestFile, JSON.stringify(task));
    const run = authorized => {
      assert.equal(git(['status', '--porcelain']).toString().trim(), '', 'fixture must satisfy the real clean-repo gate');
      const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, 'state') }; delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', requestFile,
        '--synthesize', '--root', root, '--json', ...(authorized ? ['--authorize'] : [])],
      { cwd: root, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
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
    assert.equal(result.data.synthesis.family, 'pipeline');
    if (acceptance === 'pass') {
      assert.equal(result.data.outcome, 'applied_tested');
      assert.equal(result.data.attempts[0].test.exitCode, 0);
      for (const name of ['a.js', 'b.js']) assert.notEqual(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
    } else {
      assert.equal(result.data.attempts.length, 8);
      assert.ok(result.data.attempts.every(attempt => attempt.rolledBack === true));
      for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), baseline);
    }
  }
});
