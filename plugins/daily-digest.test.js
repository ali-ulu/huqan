const test = require('node:test');
const assert = require('node:assert/strict');

const dailyDigest = require('./daily-digest');
const { utcDateKey, ensureDigestState, recordRun } = dailyDigest._test;

function fakeKernel() {
  return {};
}

test('daily-digest: utcDateKey formats as YYYY-MM-DD', () => {
  assert.equal(utcDateKey(new Date('2026-08-06T23:59:00Z')), '2026-08-06');
});

test('daily-digest: recordRun tallies run and step outcomes', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  const dateKey = '2026-08-06';

  recordRun(digestState, {
    status: 'completed',
    steps: [
      { status: 'completed' },
      { status: 'blocked' },
      { status: 'pending' },
    ],
  }, dateKey);

  const bucket = digestState.byDate[dateKey];
  assert.equal(bucket.runs, 1);
  assert.equal(bucket.runsCompleted, 1);
  assert.equal(bucket.runsBlocked, 0);
  assert.equal(bucket.steps, 3);
  assert.equal(bucket.stepsCompleted, 1);
  assert.equal(bucket.stepsBlocked, 1);
  assert.equal(bucket.stepsPending, 1);
});

test('daily-digest: a blocked run is counted as blocked, not completed', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  recordRun(digestState, { status: 'blocked', steps: [] }, '2026-08-06');
  const bucket = digestState.byDate['2026-08-06'];
  assert.equal(bucket.runsBlocked, 1);
  assert.equal(bucket.runsCompleted, 0);
});

test('daily-digest: a missing or non-blocked/completed status is counted as other, not completed', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  recordRun(digestState, null, '2026-08-06');
  recordRun(digestState, { status: 'paused', steps: [] }, '2026-08-06');
  const bucket = digestState.byDate['2026-08-06'];
  assert.equal(bucket.runs, 2);
  assert.equal(bucket.runsCompleted, 0);
  assert.equal(bucket.runsBlocked, 0);
  assert.equal(bucket.runsOther, 2);
});

test('daily-digest: separate dates accumulate independently', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  recordRun(digestState, { status: 'completed', steps: [] }, '2026-08-05');
  recordRun(digestState, { status: 'completed', steps: [] }, '2026-08-06');
  assert.equal(digestState.byDate['2026-08-05'].runs, 1);
  assert.equal(digestState.byDate['2026-08-06'].runs, 1);
});

test('daily-digest: afterAgentRun hook records into kernel state', () => {
  const kernel = fakeKernel();
  dailyDigest.afterAgentRun(kernel, { status: 'completed', steps: [{ status: 'completed' }] });
  const today = utcDateKey();
  assert.equal(kernel._dailyDigestState.byDate[today].runs, 1);
});

test('daily-digest: run() capability returns today\'s summary', () => {
  const kernel = fakeKernel();
  dailyDigest.afterAgentRun(kernel, { status: 'completed', steps: [{ status: 'completed' }] });
  dailyDigest.afterAgentRun(kernel, { status: 'blocked', steps: [{ status: 'blocked' }] });

  const result = dailyDigest.run(kernel, { action: 'summary' });
  assert.equal(result.ok, true);
  assert.equal(result.digest.runs, 2);
  assert.equal(result.digest.runsCompleted, 1);
  assert.equal(result.digest.runsBlocked, 1);
});

test('daily-digest: run() returns an empty bucket for a date with no runs', () => {
  const kernel = fakeKernel();
  const result = dailyDigest.run(kernel, { action: 'summary', date: '2020-01-01' });
  assert.equal(result.ok, true);
  assert.equal(result.digest.runs, 0);
});

test('daily-digest: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = dailyDigest.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
