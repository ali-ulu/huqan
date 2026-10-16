const test = require('node:test');
const assert = require('node:assert/strict');

const dailyDigest = require('./daily-digest');
const { utcDateKey, ensureDigestState, recordRun, pruneOldBuckets, MAX_RETAINED_DAYS } = dailyDigest._test;

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

test('daily-digest: run() rejects prototype-chain property names as dates instead of returning them (#1281)', () => {
  const kernel = fakeKernel();
  dailyDigest.afterAgentRun(kernel, { status: 'completed', steps: [] });

  for (const date of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    const result = dailyDigest.run(kernel, { action: 'summary', date });
    assert.equal(result.ok, false, date);
    assert.equal(result.code, 'INVALID_DATE', date);
    assert.equal(result.digest, undefined, date);
  }
});

test('daily-digest: run() rejects a malformed date shape that is not YYYY-MM-DD (#1281)', () => {
  const kernel = fakeKernel();
  // '' is excluded: input.date || utcDateKey() falls back to today for any
  // falsy value, same as an omitted date -- that's the existing, intended
  // "no date given" behavior, not something this validation should reject.
  for (const date of ['2026-8-6', '20260806', 'not-a-date']) {
    const result = dailyDigest.run(kernel, { action: 'summary', date });
    assert.equal(result.ok, false, date);
    assert.equal(result.code, 'INVALID_DATE', date);
  }
});

test('daily-digest: byDate is pruned to the most recent MAX_RETAINED_DAYS buckets (#1281)', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  for (let i = 0; i < MAX_RETAINED_DAYS + 30; i += 1) {
    const dateKey = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    recordRun(digestState, { status: 'completed', steps: [] }, dateKey);
  }
  assert.equal(Object.keys(digestState.byDate).length, MAX_RETAINED_DAYS);
  // The oldest buckets are the ones pruned, not the newest.
  assert.equal(Object.hasOwn(digestState.byDate, '2026-01-01'), false);
  const lastDateKey = new Date(Date.UTC(2026, 0, MAX_RETAINED_DAYS + 30)).toISOString().slice(0, 10);
  assert.equal(Object.hasOwn(digestState.byDate, lastDateKey), true);
});

test('daily-digest: pruneOldBuckets is a no-op under the retention limit', () => {
  const kernel = fakeKernel();
  const digestState = ensureDigestState(kernel);
  recordRun(digestState, { status: 'completed', steps: [] }, '2026-08-06');
  pruneOldBuckets(digestState);
  assert.equal(Object.keys(digestState.byDate).length, 1);
});

test('daily-digest: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = dailyDigest.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
