'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALARM_TITLE,
  alarmTitleForFile,
  buildIssueBody,
  collectFailedFiles,
  planAlarmActions,
} = require('../scripts/nightly-failure-alarm');

const RUN = {
  runId: '42',
  runUrl: 'https://github.com/ali-ulu/huqan/actions/runs/42',
  sha: 'abc1234',
};

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

// One issue per failing file, not one per night. A single shared issue mixed
// unrelated breakages into one thread -- #2030, #2088 and #2101 were three
// different root causes under the same title -- and each still needed its own
// fix. Keying the title on the file keeps one thread per defect.
test('each failing file gets its own issue', () => {
  const actions = planAlarmActions({
    ...RUN,
    failedFiles: [
      { shard: 1, file: 'test/a.test.js', status: 1 },
      { shard: 4, file: 'test/b.test.js', status: 1 },
    ],
    openIssues: [],
  });

  assert.deepEqual(actions.map((action) => action.title), [
    'Nightly red: test/a.test.js',
    'Nightly red: test/b.test.js',
  ]);
  assert.deepEqual(actions.map((action) => action.kind), ['create', 'create']);
  assert.match(actions[0].body, /test\/a\.test\.js/);
  assert.doesNotMatch(actions[0].body, /test\/b\.test\.js/);
});

test('a file whose issue is already open gets a comment, not a duplicate', () => {
  const actions = planAlarmActions({
    ...RUN,
    failedFiles: [
      { shard: 1, file: 'test/a.test.js', status: 1 },
      { shard: 2, file: 'test/b.test.js', status: 1 },
    ],
    openIssues: [
      { number: 42, title: alarmTitleForFile('test/a.test.js'), state: 'OPEN' },
      { number: 7, title: 'something else entirely', state: 'OPEN' },
    ],
  });

  assert.deepEqual(actions[0], {
    kind: 'comment', number: 42, title: alarmTitleForFile('test/a.test.js'), body: actions[0].body,
  });
  assert.equal(actions[1].kind, 'create');
  assert.equal(actions[1].number, null);
});

// The same file can fail on more than one shard in a matrix re-run. That is one
// defect, so it stays one issue -- with both shards named in the body.
test('one file failing on several shards is still one issue', () => {
  const actions = planAlarmActions({
    ...RUN,
    failedFiles: [
      { shard: 1, file: 'test/a.test.js', status: 1 },
      { shard: 3, file: 'test/a.test.js', status: 2 },
    ],
    openIssues: [],
  });

  assert.equal(actions.length, 1);
  assert.match(actions[0].body, /shard 1/);
  assert.match(actions[0].body, /shard 3/);
});

// A red run with nothing per-file to blame has no file to key a title on, so it
// falls back to the shared title. Losing it would restore the original
// blindness: a failed run nobody hears about.
test('a red run with no per-file failure falls back to the shared title', () => {
  const actions = planAlarmActions({ ...RUN, failedFiles: [], openIssues: [] });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].title, ALARM_TITLE);
  assert.match(actions[0].body, /no per-file failure/i);
});

// An unreadable sidecar carries a message, not a path, and the message text
// varies with the error. Keying the title on it would file a fresh issue every
// night for the same broken shard.
test('an unreadable sidecar gets one stable title, not one per error message', () => {
  const first = planAlarmActions({
    ...RUN,
    failedFiles: [{ shard: 3, file: '(unreadable sidecar: Unexpected token t)', status: null, unreadable: true }],
    openIssues: [],
  });
  const second = planAlarmActions({
    ...RUN,
    failedFiles: [{ shard: 3, file: '(unreadable sidecar: Unexpected end of JSON input)', status: null, unreadable: true }],
    openIssues: [],
  });

  assert.equal(first[0].title, second[0].title);
  assert.match(first[0].title, /sidecar/i);
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

  // The script now emits one action per failing file. A step that read only the
  // first would file an issue for one broken file and silently drop the rest.
  assert.match(job, /jq 'length' alarm\.json/);
  assert.match(job, /for index in \$\(seq 0/);
  assert.match(job, /\.\[\$\{index\}\]\.kind/);
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
