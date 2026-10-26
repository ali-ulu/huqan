'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createObservabilityQueries } = require('../lib/observability/service-queries');
const { MAX_METRIC_WINDOW_MS } = require('../lib/observability/service-constants');

function createMockService() {
  const events = [];
  const runs = [];
  let eventId = 1;
  let runId = 1;
  return {
    db: {
      prepare: (sql) => {
        return {
          all: (...params) => {
            if (sql.includes('observability_events')) {
              return events.filter(e => {
                if (params.length > 1) {
                  const since = params[1];
                  const until = params[2];
                  return e.created_at >= since && (!until || e.created_at <= until);
                }
                return true;
              }).map(e => ({ ...e }));
            }
            if (sql.includes('observability_runs')) {
              return runs.filter(r => {
                if (params.length > 1) {
                  const since = params[1];
                  const until = params[2];
                  return r.updated_at >= since && (!until || r.updated_at <= until);
                }
                return true;
              }).map(r => ({ ...r }));
            }
            return [];
          },
          get: (...params) => {
            if (sql.includes('COUNT(*)') && sql.includes('observability_runs')) {
              return { total_runs: 0, completed_runs: 0, failed_runs: 0, avg_latency_ms: null, total_tokens: 0, total_cost_micros: null, error_runs: 0 };
            }
            return null;
          },
        };
      },
    },
    now: () => Date.now(),
    statements: {
      listToolsByRun: { all: () => [] },
      countQueue: { get: () => ({ count: 0 }) },
    },
    internalMetrics: {
      measureDatabase: (ws, fn) => fn(),
      startSummary: () => () => {},
    },
    addEvent: (e) => { events.push({ ...e, eventId: eventId++ }); },
    addRun: (r) => { runs.push({ ...r, run_id: runId++ }); },
  };
}

test('service queries with invalid range (start > end) return empty', async () => {
  const mock = createMockService();
  const queries = createObservabilityQueries(mock);
  const now = Date.now();
  const result = await queries.summary({ workspaceId: 'ws', startMs: now + 1000, endMs: now });
  assert.strictEqual(result.totalRuns, 0, 'should return empty for invalid range');
});

test('service queries with valid custom range work', async () => {
  const mock = createMockService();
  const queries = createObservabilityQueries(mock);
  const now = Date.now();
  const result = await queries.summary({ workspaceId: 'ws', startMs: now - 3600000, endMs: now });
  assert.ok(result !== null);
});

test('service queries with endMs > MAX_METRIC_WINDOW_MS clamp', async () => {
  const mock = createMockService();
  const queries = createObservabilityQueries(mock);
  const now = Date.now();
  const result = await queries.summary({ workspaceId: 'ws', startMs: now - MAX_METRIC_WINDOW_MS - 1000, endMs: now });
  assert.ok(result !== null);
});

test('service queries with default windowMs work', async () => {
  const mock = createMockService();
  const queries = createObservabilityQueries(mock);
  const result = await queries.summary({ workspaceId: 'ws', windowMs: 86400000 });
  assert.ok(result !== null);
});