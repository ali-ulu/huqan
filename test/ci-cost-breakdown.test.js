'use strict';

// Issue #3502 (R48 E5, OLCM-ONCE): the cost-breakdown classifier separates
// queue-wait / setup / test / upload per job. Fixture-based, no network:
// the step names below are the real ones `benchmark.yml` emits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildReport,
  classifyStep,
  main,
  parseArgs,
  summarizeJob,
} = require('../scripts/ci-cost-breakdown');

const RUN_CREATED = '2026-10-04T21:29:47Z';

function step(name, startedAt, completedAt, conclusion = 'success') {
  return { name, started_at: startedAt, completed_at: completedAt, conclusion };
}

function shardJob() {
  return {
    name: 'npm test (runtime/test selected, windows-latest, Node 24, shard 2)',
    conclusion: 'success',
    runner_name: 'GitHub Actions 1000158968',
    started_at: '2026-10-04T21:32:41Z',
    completed_at: '2026-10-04T21:38:29Z',
    steps: [
      step('Set up job', '2026-10-04T21:32:42Z', '2026-10-04T21:32:44Z'),
      step('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '2026-10-04T21:32:44Z', '2026-10-04T21:32:52Z'),
      step('Run actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        '2026-10-04T21:32:54Z', '2026-10-04T21:33:02Z'),
      step('Run npm ci --include=optional',
        '2026-10-04T21:33:02Z', '2026-10-04T21:33:14Z'),
      step('Download validated impact plan',
        '2026-10-04T21:33:14Z', '2026-10-04T21:33:15Z'),
      step('Run selected weighted test shard',
        '2026-10-04T21:33:15Z', '2026-10-04T21:38:22Z'),
      step('Upload JUnit timing report',
        '2026-10-04T21:38:22Z', '2026-10-04T21:38:23Z'),
      step('Upload shard failure sidecar',
        '2026-10-04T21:38:23Z', '2026-10-04T21:38:25Z'),
      step('Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '2026-10-04T21:38:25Z', '2026-10-04T21:38:27Z'),
      step('Complete job', '2026-10-04T21:38:27Z', '2026-10-04T21:38:27Z'),
    ],
  };
}

function coverageJob() {
  return {
    name: 'Coverage',
    conclusion: 'success',
    runner_name: 'GitHub Actions 1000158969',
    started_at: '2026-10-04T21:29:58Z',
    completed_at: '2026-10-04T21:40:02Z',
    steps: [
      step('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '2026-10-04T21:30:01Z', '2026-10-04T21:30:03Z'),
      step('Install Chromium for the browser smokes',
        '2026-10-04T21:30:07Z', '2026-10-04T21:31:18Z'),
      step('Measure the suite under c8',
        '2026-10-04T21:31:18Z', '2026-10-04T21:39:59Z'),
      step('Enforce the coverage ratchet',
        '2026-10-04T21:39:59Z', '2026-10-04T21:39:59Z'),
      step('Upload the coverage summary',
        '2026-10-04T21:39:59Z', '2026-10-04T21:40:00Z'),
    ],
  };
}

test('classifyStep separates setup, test, and upload steps', () => {
  assert.equal(classifyStep('Set up job'), 'setup');
  assert.equal(classifyStep('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'), 'setup');
  assert.equal(classifyStep('Fetch baseline branch for live Git validation'), 'setup');
  assert.equal(classifyStep('Run actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'), 'setup');
  assert.equal(classifyStep('Run npm ci --include=optional'), 'setup');
  assert.equal(classifyStep('Install Chromium for the browser smokes'), 'setup');
  assert.equal(classifyStep('Download validated impact plan'), 'setup');
  assert.equal(classifyStep('Run selected weighted test shard'), 'test');
  assert.equal(classifyStep('Measure the suite under c8'), 'test');
  assert.equal(classifyStep('Enforce the coverage ratchet'), 'test');
  assert.equal(classifyStep('Run benchmark'), 'test');
  assert.equal(classifyStep('Upload JUnit timing report'), 'upload');
  assert.equal(classifyStep('Upload the coverage summary'), 'upload');
  assert.equal(classifyStep('Complete job'), 'other');
});

test('summarizeJob splits queue-wait from setup/test/upload', () => {
  const summary = summarizeJob(shardJob(), new Date(RUN_CREATED).getTime());
  // Queue: job start 21:32:41 minus run created 21:29:47 = 174s.
  assert.equal(summary.queueSeconds, 174);
  // Setup: 2 (set up) + 8 (checkout) + 8 (setup-node) + 12 (npm ci)
  // + 1 (plan) + 2 (post-run checkout teardown).
  assert.equal(summary.setupSeconds, 33);
  // Test: the shard run alone, 307s.
  assert.equal(summary.testSeconds, 307);
  // Upload: two 1-2s artifact uploads.
  assert.equal(summary.uploadSeconds, 3);
  assert.equal(summary.durationSeconds, 348);
});

test('buildReport names the slowest job and the shard p50', () => {
  const report = buildReport({
    jobs: [shardJob(), coverageJob()],
    runCreated: RUN_CREATED,
    runUpdated: '2026-10-04T21:40:08Z',
    runId: '37236318564',
    headSha: 'a8228ce1',
    event: 'push',
    impactPlan: null,
    timings: null,
  });
  assert.equal(report.slowestJob.name, 'Coverage');
  assert.equal(report.slowestJob.durationSeconds, 604);
  assert.ok(report.slowestJob.testSeconds > 500);
  assert.equal(report.runnerSumSeconds, 952);
  assert.equal(report.shards.count, 1);
  assert.equal(report.shards.slowestShard, shardJob().name);
  assert.deepEqual(report.wallDeterminants, ['Coverage', shardJob().name]);
  assert.equal(report.firstFeedback.job, shardJob().name);
  assert.match(report.scope, /no billing/i);
});

test('main reads jobs from stdin and writes the report file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cost-breakdown-'));
  try {
    const jobsPath = path.join(directory, 'jobs.json');
    fs.writeFileSync(jobsPath, JSON.stringify({ total_count: 1, jobs: [coverageJob()] }));
    const output = path.join(directory, 'report.json');
    const code = main([
      `--jobs=${jobsPath}`,
      `--run-created=${RUN_CREATED}`,
      '--run-updated=2026-10-04T21:40:08Z',
      '--run-id=37236318564',
      `--output=${output}`,
    ]);
    assert.equal(code, 0);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.slowestJob.name, 'Coverage');
    assert.equal(report.source.runId, '37236318564');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parseArgs rejects missing required inputs', () => {
  assert.throws(() => parseArgs([]), /--jobs/);
  assert.throws(() => parseArgs(['--jobs=-']), /--run-created/);
  assert.throws(() => parseArgs(['--jobs=-', '--run-created=not-a-date']), /invalid/);
  assert.throws(() => parseArgs(['--jobs=-', '--run-created=2026-10-04T21:29:47Z', '--skip=yes']), /unsupported/);
});
