'use strict';

/**
 * #3618 (R53): the run row counts a bounded step history exactly.
 *
 * Once `state.steps` is a bounded ring, the Observability layer can only see
 * the held tail. It reads the array's own `stepHistoryTotals` (written by the
 * Core ring, read here without importing Core) so `afterAgentRun` still records
 * every step: the true step count, the per-status totals, and the usage sums,
 * with a usage field unknown on any step staying null. Without tallies the row
 * is byte-identical to the pre-#3618 shape.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');

const NOW = 1_700_000_000_000;

function fixture(t) {
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => NOW });
  t.after(() => db.close());
  return service;
}

function finish(service, steps, extra = {}) {
  service.recordLifecycle('afterAgentRun', {
    state: {
      workspaceId: 'ws-a',
      observabilityRunId: 'run-bounded',
      traceId: 'trace-b',
      status: 'completed',
      startedAt: new Date(NOW - 1000).toISOString(),
      steps,
      ...extra,
    },
  });
  return service.listRuns({ workspaceId: 'ws-a' }).items[0];
}

test('a bounded history keeps the true step count and per-status totals in the run row', t => {
  const service = fixture(t);
  const steps = [{ status: 'done', result: { usage: { tokens: 5, costMicros: 0 } } }];
  steps.stepHistoryTotals = {
    count: 40,
    statuses: { done: 30, blocked: 8, error: 2 },
    usage: { tokens: 100, inputTokens: 60, outputTokens: 40, costMicros: 0 },
    usageUnknown: { tokens: false, inputTokens: false, outputTokens: false, costMicros: true },
    usageKnown: true,
  };
  const run = finish(service, steps);
  assert.equal(run.stepCount, 41, 'held + dropped');
  assert.equal(run.successfulSteps, 31, '30 dropped done + 1 held done');
  assert.equal(run.blockedSteps, 8);
  assert.equal(run.errorSteps, 2);
  assert.equal(run.tokens, 105, 'dropped usage folded into the held step');
  assert.equal(run.costMicros, null, 'a field unknown on any step stays null, never a partial zero');
});

test('a history with no tallies is recorded exactly as before the ring', t => {
  const service = fixture(t);
  const steps = [
    { status: 'done' },
    { status: 'blocked' },
    { status: 'error' },
    { status: 'review' },
  ];
  const run = finish(service, steps);
  assert.equal(run.stepCount, 4);
  assert.equal(run.successfulSteps, 1);
  assert.equal(run.blockedSteps, 1);
  assert.equal(run.errorSteps, 2, 'error and review both count as error steps');
  assert.equal(run.tokens, null, 'no step measured tokens, so the row carries none');
  assert.equal(run.costKnown, false);
});

test('a dropped usage total folds into the held usage of the same field', t => {
  const service = fixture(t);
  const steps = [{ status: 'done', result: { usage: { tokens: 5, inputTokens: 3, outputTokens: 2, costMicros: 0 } } }];
  steps.stepHistoryTotals = {
    count: 2,
    statuses: { done: 2 },
    usage: { tokens: 10, inputTokens: 6, outputTokens: 4, costMicros: 0 },
    usageUnknown: {},
    usageKnown: true,
  };
  const run = finish(service, steps);
  assert.equal(run.tokens, 15, 'held 5 + dropped 10');
  assert.equal(run.inputTokens, 9);
  assert.equal(run.outputTokens, 6);
  assert.equal(run.stepCount, 3);
});

test('an explicit unknown usage field stays null across an upsert, never a prior run number', t => {
  const service = fixture(t);
  const resume = steps => service.recordLifecycle('afterAgentRun', {
    state: {
      workspaceId: 'ws-a', observabilityRunId: 'run-resumed', status: 'completed',
      startedAt: new Date(NOW - 1000).toISOString(), steps,
    },
  });
  // First finish measures tokens; the resumed finish measures cost but leaves
  // the token fields explicitly null. The prior 7 must not resurface as a
  // partial total.
  resume([{ status: 'done', result: { usage: { tokens: 7 } } }]);
  assert.equal(service.listRuns({ workspaceId: 'ws-a' }).items[0].tokens, 7);
  resume([{ status: 'done', result: { usage: { tokens: null, inputTokens: null, outputTokens: null, costMicros: 5 } } }]);
  const run = service.listRuns({ workspaceId: 'ws-a' }).items[0];
  assert.equal(run.tokens, null, 'an explicitly unknown field stays null');
  assert.equal(run.inputTokens, null);
  assert.equal(run.outputTokens, null);
  assert.equal(run.costMicros, 5, 'a field the run did measure still lands');
});

test('a snake_case null usage field is honored the same as its camelCase twin', t => {
  const service = fixture(t);
  // `upsertRun` is public and `extractUsage` reads snake_case aliases, so a
  // direct caller passing `usage: { input_tokens: null }` must also keep the
  // field unknown rather than restoring the prior row's number.
  service.upsertRun({ workspaceId: 'ws-a', runId: 'run-snake', status: 'running', usage: { input_tokens: 9, output_tokens: 4, cost_micros: 3 } });
  service.upsertRun({ workspaceId: 'ws-a', runId: 'run-snake', status: 'completed', usage: { input_tokens: null, output_tokens: null, cost_micros: null } });
  const run = service.listRuns({ workspaceId: 'ws-a' }).items[0];
  assert.equal(run.inputTokens, null, 'a snake_case null stays null');
  assert.equal(run.outputTokens, null);
  assert.equal(run.costMicros, null);
  assert.equal(run.costKnown, false, 'an unknown cost is not reported as known');
});

test('a held step with no usage leaves the field unknown even when dropped steps measured it', t => {
  const service = fixture(t);
  // The Observability layer treats a held step with no usage object as making
  // the run-wide field unknown; the dropped fold never turns that null into a
  // smaller number.
  const steps = [{ status: 'done' }];
  steps.stepHistoryTotals = {
    count: 2,
    statuses: { done: 2 },
    usage: { tokens: 10, inputTokens: 6, outputTokens: 4, costMicros: 0 },
    usageUnknown: {},
    usageKnown: true,
  };
  const run = finish(service, steps);
  assert.equal(run.tokens, null);
  assert.equal(run.stepCount, 3);
});
