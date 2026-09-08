'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALARM_TITLE,
  buildIssueBody,
  chooseAction,
  collectFailedFiles,
} = require('../scripts/nightly-failure-alarm');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-alarm-test-'));
}

// The whole point of the failure sidecar is that the JUnit report cannot be
// trusted for this: a test file that declares only top-level `test(...)` calls
// produces no <testsuite> element, and scripts/run-test-shard.js merges only
// <testsuite> blocks. On 2026-09-05 shard 5 exited non-zero on
// test/enforcement-coverage.test.js while its uploaded report said
// failures="0" with no <failure> element anywhere. An alarm reading that report
// would have announced a green suite for a red run.
test('failed files are collected from every shard sidecar, not from JUnit', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'test-shard-1-failures.json'), JSON.stringify({
    shard: 1, total: 5, failedFiles: [{ file: 'test/a.test.js', status: 1 }],
  }));
  fs.writeFileSync(path.join(dir, 'test-shard-4-failures.json'), JSON.stringify({
    shard: 4, total: 5, failedFiles: [{ file: 'test/b.test.js', status: 1 }],
  }));
  fs.writeFileSync(path.join(dir, 'test-shard-2-failures.json'), JSON.stringify({
    shard: 2, total: 5, failedFiles: [],
  }));

  const collected = collectFailedFiles(dir);

  assert.deepEqual(collected, [
    { shard: 1, file: 'test/a.test.js', status: 1 },
    { shard: 4, file: 'test/b.test.js', status: 1 },
  ]);
});

test('a shard that produced no sidecar is reported, never silently dropped', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'test-shard-3-failures.json'), '{ this is not json');

  const collected = collectFailedFiles(dir);

  assert.equal(collected.length, 1);
  assert.equal(collected[0].shard, 3);
  assert.match(collected[0].file, /unreadable/i);
});

test('the issue body names the run and every failed file', () => {
  const body = buildIssueBody({
    runId: '34095072502',
    runUrl: 'https://github.com/ali-ulu/huqan/actions/runs/34095072502',
    sha: 'e3b98d54',
    failedFiles: [{ shard: 1, file: 'test/faz2-production-plugin-signing-enforcement.test.js', status: 1 }],
  });

  assert.match(body, /34095072502/);
  assert.match(body, /actions\/runs\/34095072502/);
  assert.match(body, /e3b98d54/);
  assert.match(body, /test\/faz2-production-plugin-signing-enforcement\.test\.js/);
  assert.match(body, /shard 1/i);
});

// A red nightly with no sidecar entry is still a red nightly -- the run failed
// somewhere else (impact plan, install, a hung shard). Saying "no failures" and
// opening nothing is how the alarm would reproduce the blindness it exists to
// remove.
test('a red run with no collected file still produces a body that says so', () => {
  const body = buildIssueBody({
    runId: '1', runUrl: 'https://example.invalid/1', sha: 'abc1234', failedFiles: [],
  });

  assert.match(body, /no per-file failure/i);
  assert.match(body, /1/);
});

test('an existing open alarm issue is commented on rather than duplicated', () => {
  assert.deepEqual(
    chooseAction([{ number: 42, title: ALARM_TITLE, state: 'OPEN' }]),
    { kind: 'comment', number: 42 },
  );
  assert.deepEqual(chooseAction([]), { kind: 'create', number: null });
  assert.deepEqual(
    chooseAction([{ number: 7, title: 'something else entirely', state: 'OPEN' }]),
    { kind: 'create', number: null },
  );
});

// Every assertion above reads a sidecar this test file wrote itself. That
// proves the parser and says nothing about whether a real shard produces the
// file at all -- so run one and look.
test('a real shard run writes the sidecar the alarm depends on', () => {
  const dir = scratch();
  const selection = path.join(dir, 'selection.json');
  fs.writeFileSync(selection, JSON.stringify({
    schemaVersion: 1, selectedTests: ['test/is-plain-object.test.js'],
  }));
  const report = path.join(dir, 'test-shard-1.xml');
  const repoRoot = path.join(__dirname, '..');

  const run = require('node:child_process').spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'run-test-shard.js'),
    `--selection=${selection}`, '--shard=1', '--total=1', '--concurrency=1', `--report=${report}`,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });

  const { failuresSidecarPath } = require('../scripts/run-test-shard');
  const sidecar = failuresSidecarPath(report, 1);
  assert.ok(fs.existsSync(sidecar), `shard wrote no sidecar (status ${run.status}): ${run.stderr}`);
  const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(parsed.shard, 1);
  assert.deepEqual(parsed.failedFiles, []);
  assert.deepEqual(collectFailedFiles(dir), []);
});

test('the workflow arms the alarm only on a failed scheduled run', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'),
    'utf8',
  );
  const job = workflow.slice(workflow.indexOf('  nightly-failure-alarm:'));
  assert.ok(job.startsWith('  nightly-failure-alarm:'), 'benchmark.yml must define nightly-failure-alarm');

  // failure() alone would fire on every red pull request; the schedule guard is
  // what keeps this to the nightly full-suite run.
  assert.match(job, /if:\s*\$\{\{\s*failure\(\)\s*&&\s*github\.event_name\s*==\s*'schedule'\s*\}\}/);
  assert.match(job, /needs:\s*\[runtime-test\]/);
  assert.match(job, /issues:\s*write/);
  assert.match(job, /node scripts\/nightly-failure-alarm\.js/);
});

test('every shard uploads its failure sidecar even when the shard fails', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'),
    'utf8',
  );
  const upload = workflow.slice(workflow.indexOf('      - name: Upload shard failure sidecar'));
  assert.ok(upload.startsWith('      - name: Upload shard failure sidecar'), 'sidecar upload step must exist');
  // A shard that fails is exactly the shard whose sidecar the alarm needs.
  assert.match(upload.slice(0, 400), /if:\s*always\(\)/);
});
