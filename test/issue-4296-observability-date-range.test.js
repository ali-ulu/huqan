'use strict';

/**
 * #4296: the observability dashboard's custom date range.
 *
 * A custom range is two absolute epoch-millisecond bounds. The read side
 * applies both bounds to the event list, the run list and the summary, caps the
 * span at the maximum a relative window may cover, and answers an invalid range
 * with an empty result rather than the whole history.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');
const { MAX_METRIC_WINDOW_MS } = require('../lib/observability/service-constants');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function fixture(t) {
  let clock = T0;
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => clock });
  t.after(() => db.close());
  // One finished run (with one tool step) per day: day 0, day 1, day 2.
  for (const day of [0, 1, 2]) {
    clock = T0 + day * DAY;
    const runId = `run-day-${day}`;
    service.recordRunStart({ workspaceId: 'ws-a', runId });
    service.recordStep({ workspaceId: 'ws-a', runId, tool: 'search', status: 'done' });
    service.recordRunFinish({ workspaceId: 'ws-a', runId, status: 'completed', finishedAt: clock, durationMs: 100 + day });
  }
  clock = T0 + 3 * DAY;
  return service;
}

const runIds = page => page.items.map(run => run.runId).sort();

test('a custom range bounds the run list, the event list and the summary on both sides', t => {
  const service = fixture(t);
  const range = { workspaceId: 'ws-a', startMs: T0 + DAY - 1, endMs: T0 + DAY + 1 };

  assert.deepEqual(runIds(service.listRuns(range)), ['run-day-1']);
  const events = service.listEvents(range).items;
  assert.ok(events.length > 0);
  assert.ok(events.every(event => event.runId === 'run-day-1'), 'events outside the range are excluded');

  const summary = service.summary(range);
  assert.equal(summary.totalRuns, 1, 'the end bound applies to the summary, not only the start');
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.p95LatencyMs, 101);
  assert.deepEqual(summary.toolUsage, [{ name: 'search', count: 1 }]);
  assert.equal(summary.windowMs, 2);
  assert.equal(summary.since, new Date(T0 + DAY - 1).toISOString());
});

test('a relative window still covers everything up to now', t => {
  const service = fixture(t);
  assert.deepEqual(runIds(service.listRuns({ workspaceId: 'ws-a', windowMs: String(2 * DAY) })), ['run-day-1', 'run-day-2']);
  const summary = service.summary({ workspaceId: 'ws-a', windowMs: 4 * DAY });
  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.windowMs, 4 * DAY);
  // A blank windowMs (the router forwards null when absent) keeps the default window.
  assert.equal(service.summary({ workspaceId: 'ws-a', windowMs: null }).windowMs, DAY);
  assert.equal(service.listRuns({ workspaceId: 'ws-a' }).items.length, 3, 'no window, no range: the full list');
});

test('a range wider than the maximum window is capped at its end', t => {
  const service = fixture(t);
  const summary = service.summary({ workspaceId: 'ws-a', startMs: 0, endMs: T0 + 3 * DAY });
  assert.equal(summary.windowMs, MAX_METRIC_WINDOW_MS);
  assert.equal(summary.since, new Date(T0 + 3 * DAY - MAX_METRIC_WINDOW_MS).toISOString());
  assert.equal(summary.totalRuns, 3);
});

test('an invalid range fails closed on every read instead of widening to the whole history', t => {
  const service = fixture(t);
  const invalid = [
    { startMs: T0 + 2 * DAY, endMs: T0 }, // start after end
    { startMs: T0 }, // end missing
    { endMs: T0 }, // start missing
    { startMs: Number.NaN, endMs: T0 },
    { startMs: -1, endMs: T0 },
    { startMs: T0, endMs: T0 + 0.5 },
    { startMs: '1700000000000', endMs: T0 },
  ];
  for (const range of invalid) {
    const input = { workspaceId: 'ws-a', ...range };
    const label = JSON.stringify(range);
    assert.deepEqual(service.listRuns(input), { items: [], limit: 50, hasMore: false, nextCursor: null }, label);
    assert.deepEqual(service.listEvents(input).items, [], label);
    const summary = service.summary(input);
    assert.equal(summary.totalRuns, 0, label);
    assert.equal(summary.windowMs, 0, label);
    assert.equal(summary.since, null, label);
    assert.deepEqual(summary.toolUsage, [], label);
  }
});
