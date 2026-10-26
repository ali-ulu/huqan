'use strict';

// #4245 / #4288: a pull-request classification must diff from the merge base.
// A branch that has fallen behind main is normal (strict_required_status_checks_policy
// is off), and a two-dot `git diff base.sha head.sha` then reports main's own newer
// commits as "changed" -- a perf-sensitive commit on main ran the soak gate on a
// test-only PR and failed the required Benchmark gate on an unrelated cpuRatio.
// The same two-dot pattern sat in three more places; each one misroutes a gate.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { readChangedFiles } = require('../scripts/ci-impact-plan-paths');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const conformance = read('.github', 'workflows', 'conformance.yml');
const rustAccelerator = read('.github', 'workflows', 'rust-accelerator.yml');
const impactPlanPaths = read('scripts', 'ci-impact-plan-paths.js');

test('the conformance gate diffs the pull request from the merge base', () => {
  assert.match(conformance, /git diff --name-only "\$BASE_SHA\.\.\.\$HEAD_SHA"/,
    'conformance.yml must use a three-dot diff of BASE_SHA and HEAD_SHA');
  assert.doesNotMatch(conformance, /git diff --name-only "\$BASE_SHA" "\$HEAD_SHA"/,
    'the two-dot diff reports main\'s own newer commits as changed');
  // `github.sha` on a pull_request event is the synthetic merge commit, whose
  // tree already contains the base. A diff from the base to it omits a path the
  // pull request changed when the base changed it identically, so the head must
  // be the pull request head (the idiom benchmark.yml already uses).
  assert.match(conformance, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
    'the diff head must be the pull request head, not the synthetic merge commit');
});

test('the rust-accelerator gate diffs the pull request from the merge base', () => {
  assert.match(rustAccelerator, /range="\$\{base\}\.\.\.\$\{head\}"/,
    'the pull_request branch must build a three-dot range');
  assert.match(rustAccelerator, /git diff --name-only \$\{range\}/,
    'the diff must consume that range');
  assert.doesNotMatch(rustAccelerator, /git diff --name-only "\$\{base\}" "\$\{head\}"/,
    'the two-dot diff reports main\'s own newer commits as changed');
});

test('changed-file discovery diffs from the merge base, not the base tip', (t) => {
  assert.match(impactPlanPaths, /`\$\{base\}\.\.\.\$\{head\}`/,
    'readChangedFiles must pass a three-dot range to git diff');

  if (!usableGit()) return t.skip('requires a usable git');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-impact-merge-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const commit = (message) => {
    git('add', '-A');
    const done = git('commit', '-q', '-m', message);
    assert.equal(done.status, 0, done.stderr);
  };

  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'base.js'), 'base\n');
  commit('base');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'lib', 'feature.test.js'), 'test\n');
  commit('test-only change');
  git('checkout', '-q', 'main');
  fs.mkdirSync(path.join(dir, 'lib', 'receipt'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'receipt', 'perf.js'), 'perf\n');
  commit('perf-sensitive change on main');

  const baseTip = git('rev-parse', 'main').stdout.trim();
  const headTip = git('rev-parse', 'feature').stdout.trim();
  assert.deepEqual(readChangedFiles({ root: dir, base: baseTip, head: headTip }), ['lib/feature.test.js'],
    'a behind-main pull request must not report main\'s own files as changed');
});

function usableGit() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}
