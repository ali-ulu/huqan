'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_RECENT_STEP_REPORTS,
  boundStepHistory,
  pushStepReport,
  summarizeStepHistory,
} = require('../lib/bounded-step-history');
const { recordStepReport } = require('../lib/agent-step-progression');
const { saveRunCheckpoint, hydrateRunState } = require('../lib/agent-v3-run-state');

function report(status, extra = {}) {
  return { action: `a-${status}`, tool: 'search', status, summary: status, result: { tag: status }, ...extra };
}

test('a short history is never trimmed: every report stays and the totals are the held ones', () => {
  const steps = [];
  for (let i = 0; i < 5; i += 1) pushStepReport(steps, report('ok'), 8);
  assert.equal(steps.length, 5);
  const summary = summarizeStepHistory(steps);
  assert.equal(summary.total, 5);
  assert.equal(summary.held, 5);
  assert.equal(summary.dropped, 0);
  assert.deepEqual(summary.statuses, { ok: 5 });
});

test('past the cap the ring keeps the most recent reports and drops the oldest', () => {
  const steps = [];
  for (let i = 0; i < 10; i += 1) pushStepReport(steps, report('ok', { seq: i }), 3);
  assert.equal(steps.length, 3, 'the ring is bounded to the cap');
  assert.deepEqual(steps.map(s => s.seq), [7, 8, 9], 'the most recent three are kept');
  const summary = summarizeStepHistory(steps);
  assert.equal(summary.total, 10, 'the true count is never lost');
  assert.equal(summary.held, 3);
  assert.equal(summary.dropped, 7);
});

test('per-status tallies stay exact across a drop, so a reader that scanned the array is not fooled', () => {
  const steps = [];
  pushStepReport(steps, report('ok'), 2);
  pushStepReport(steps, report('blocked'), 2);
  pushStepReport(steps, report('ok'), 2);
  pushStepReport(steps, report('error'), 2);
  assert.equal(steps.length, 2);
  const summary = summarizeStepHistory(steps);
  assert.deepEqual(summary.statuses, { ok: 2, blocked: 1, error: 1 });
  assert.equal(summary.total, 4);
  assert.equal(summary.dropped, 2);
});

test('usage sums stay exact across a drop, and a field unknown on any step stays unknown', () => {
  const steps = [];
  pushStepReport(steps, report('ok', { result: { usage: { tokens: 10, input_tokens: 4, output_tokens: 6, cost_micros: 100 } } }), 1);
  pushStepReport(steps, report('ok', { result: { usage: { tokens: 20, input_tokens: 8, output_tokens: 12, cost_micros: 200 } } }), 1);
  pushStepReport(steps, report('ok', { result: { usage: { tokens: 30 } } }), 1);
  assert.equal(steps.length, 1);
  const summary = summarizeStepHistory(steps);
  // Every step reported tokens, so that total is exact across the drop.
  assert.equal(summary.usage.tokens, 60);
  // The last held step reported no input/output/cost: a field missing on any
  // step keeps the run-wide total for that field unknown, never a smaller
  // number (the dropped steps' 12/18/300 must not sneak back as a "total").
  assert.equal(summary.usage.inputTokens, null);
  assert.equal(summary.usage.outputTokens, null);
  assert.equal(summary.usage.costMicros, null);
  assert.equal(summary.usageKnown, true);
  assert.deepEqual(summary.usageUnknown, { tokens: false, inputTokens: true, outputTokens: true, costMicros: true });
});

test('a run with no usage on any step reports usageKnown false, never a zero total', () => {
  const steps = [];
  for (let i = 0; i < 4; i += 1) pushStepReport(steps, report('ok'), 2);
  const summary = summarizeStepHistory(steps);
  assert.equal(summary.usageKnown, false);
  assert.equal(summary.usage.tokens, 0);
});

test('the default cap is far above the default step ceiling, so a normal run is never trimmed', () => {
  assert.ok(DEFAULT_MAX_RECENT_STEP_REPORTS >= 16);
});

test('boundStepHistory is idempotent and safe on a non-array', () => {
  const steps = [report('ok'), report('ok'), report('ok')];
  assert.equal(boundStepHistory(steps, 2), 1);
  assert.equal(boundStepHistory(steps, 2), 0, 'nothing left to drop');
  assert.equal(boundStepHistory(null, 2), 0);
  assert.equal(boundStepHistory('nope', 2), 0);
});

test('recordStepReport routes the write through the ring: a long run stays bounded but keeps exact totals', () => {
  const runtime = {
    collectEvidence: () => [],
    updateToolStats: () => {},
  };
  const state = { steps: [], evidence: [], notes: [] };
  for (let i = 0; i < 100; i += 1) {
    recordStepReport(runtime, state, report(i % 3 === 0 ? 'ok' : 'blocked', { seq: i }));
  }
  // The ceiling at 32 held reports is enforced on the live array a downstream
  // reader sees; the count of steps that actually happened is preserved.
  assert.equal(state.steps.length, DEFAULT_MAX_RECENT_STEP_REPORTS);
  const summary = summarizeStepHistory(state.steps);
  assert.equal(summary.total, 100);
  assert.equal(summary.dropped, 100 - DEFAULT_MAX_RECENT_STEP_REPORTS);
  assert.equal(summary.statuses.ok + summary.statuses.blocked, 100);
});

test('the ring stays an array with the same identity, so existing readers keep working', () => {
  const steps = [];
  const before = pushStepReport(steps, report('ok'), 1);
  assert.equal(before, steps[0], 'the pushed report is returned');
  assert.ok(Array.isArray(steps));
  // A short run carries no tally carrier; only a drop introduces one.
  assert.equal(steps.stepHistoryTotals, undefined);
  pushStepReport(steps, report('ok'), 1);
  assert.equal(typeof steps.stepHistoryTotals, 'object');
  assert.ok(Array.isArray(steps), 'the trimmed history is still an array');
});

test('a checkpoint carries the tallies as a JSON-safe sibling, so a resume keeps the true count', () => {
  const state = { goal: 'g', objective: 'o', workspaceId: 'w', steps: [], queuedSteps: [], evidence: [], notes: [], iteration: 0, startedAt: new Date(0).toISOString() };
  for (let i = 0; i < 40; i += 1) pushStepReport(state.steps, report(i % 2 ? 'blocked' : 'done', { seq: i }));
  assert.equal(state.steps.length, DEFAULT_MAX_RECENT_STEP_REPORTS);
  let saved = null;
  const checkpointId = saveRunCheckpoint(state, { storage: { saveCheckpoint: (record) => { saved = record; } } });
  // Storage persists JSON; a round trip must not lose the tallies, which live
  // as a sibling of `state` precisely because an array cannot carry them.
  saved = JSON.parse(JSON.stringify(saved));
  assert.equal(saved.checkpointId, checkpointId);
  assert.equal(saved.stepHistoryTotals.count, 40 - DEFAULT_MAX_RECENT_STEP_REPORTS);
  const resumed = hydrateRunState({ goal: 'g', objective: 'o', steps: [], selectedTools: [] }, saved);
  const summary = summarizeStepHistory(resumed.steps);
  assert.equal(summary.total, 40, 'the resumed run keeps counting the dropped steps');
  assert.equal(summary.dropped, 40 - DEFAULT_MAX_RECENT_STEP_REPORTS);
  assert.equal(resumed.completedSteps, 40);
});
