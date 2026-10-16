'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');
const { OBSERVABILITY_API_PREFIX, observabilityOpenApiDocument } = require('../lib/observability/api-contract');

function harness() {
  const writes = [];
  const serviceCalls = [];
  const subscriptions = [];
  const service = {
    summary(input) {
      serviceCalls.push({ method: 'summary', input });
      return { totalRuns: 0 };
    },
    queueSummary(input) {
      serviceCalls.push({ method: 'queueSummary', input });
      return { depth: 0, oldestLagMs: 0 };
    },
    listAlerts(input) {
      serviceCalls.push({ method: 'listAlerts', input });
      return [];
    },
    internalMetrics(input) {
      serviceCalls.push({ method: 'internalMetrics', input });
      return {
        workspaceId: input.workspaceId,
        subscriberCount: 1,
        eventWrites: { attempted: 2, succeeded: 2, failed: 0 },
        droppedEvents: 0,
        projectionFailures: 0,
        summary: { calls: 1, totalDurationMs: 0, slowCalls: 0 },
        alertEvaluation: { calls: 1, failures: 0, totalDurationMs: 0 },
        database: { calls: 4, totalDurationMs: 1, slowCalls: 0 },
        verification_latency_ms: { count: 3, p50: 10, p95: 30, p99: 30 },
        retrieval_latency_ms: { count: 2, p50: 5, p95: 8, p99: 8 },
        graph_operations_total: { read: 2, write: 1, delete: 0, traverse: 1 },
        denied_actions_total: { policy_denied: 2 },
        approval_requests_total: { allow: 1, review: 2, block: 1 },
        db_errors_total: { sqlite_busy: 1 },
        rust_fallback_total: 1,
      };
    },
    subscribe(listener, options) {
      subscriptions.push({ listener, options });
      return () => {};
    },
  };
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => null,
    writeJson: (_req, _res, status, response, headers) => writes.push({ status, response, headers }),
    denyIfUnauthorized: req => {
      req.huqanAuth = Object.freeze({ subject: 'internal-metrics-contract' });
      return true;
    },
    authorizeWorkspace: () => ({ allowed: true }),
    rateLimiter: { acquire: () => ({ allowed: true, release() {} }) },
  });
  return { router, writes, serviceCalls, subscriptions };
}

test('metrics response exposes only the bounded internal snapshot for the requested workspace', async () => {
  const h = harness();
  const handled = await h.router(
    { method: 'GET', headers: {} },
    {},
    new URL(`http://local${OBSERVABILITY_API_PREFIX}/metrics?workspaceId=workspace-a`),
  );
  assert.equal(handled, true);
  assert.equal(h.writes[0].status, 200);
  assert.deepEqual(h.serviceCalls.map(call => call.method), ['summary', 'queueSummary', 'listAlerts', 'internalMetrics']);
  assert.deepEqual(h.serviceCalls.at(-1).input, { workspaceId: 'workspace-a' });
  assert.deepEqual(h.writes[0].response.data.internal, {
    workspaceId: 'workspace-a',
    subscriberCount: 1,
    eventWrites: { attempted: 2, succeeded: 2, failed: 0 },
    droppedEvents: 0,
    projectionFailures: 0,
    summary: { calls: 1, totalDurationMs: 0, slowCalls: 0 },
    alertEvaluation: { calls: 1, failures: 0, totalDurationMs: 0 },
    database: { calls: 4, totalDurationMs: 1, slowCalls: 0 },
    verification_latency_ms: { count: 3, p50: 10, p95: 30, p99: 30 },
    retrieval_latency_ms: { count: 2, p50: 5, p95: 8, p99: 8 },
    graph_operations_total: { read: 2, write: 1, delete: 0, traverse: 1 },
    denied_actions_total: { policy_denied: 2 },
    approval_requests_total: { allow: 1, review: 2, block: 1 },
    db_errors_total: { sqlite_busy: 1 },
    rust_fallback_total: 1,
  });
});

test('SSE subscription is scoped to the exact requested workspace', async () => {
  const h = harness();
  const writes = [];
  const req = { method: 'GET', headers: {}, once: (_event, listener) => writes.push({ event: _event, listener }) };
  const res = {
    writableEnded: false,
    writeHead(status, headers) { writes.push({ status, headers }); },
    write(chunk) { writes.push({ chunk }); return true; },
    once: (_event, listener) => writes.push({ event: _event, listener }),
  };
  const handled = await h.router(req, res, new URL(`http://local${OBSERVABILITY_API_PREFIX}/stream?workspaceId=workspace-a`));
  assert.equal(handled, true);
  assert.equal(h.subscriptions.length, 1);
  assert.deepEqual(h.subscriptions[0].options, { workspaceId: 'workspace-a' });
  assert.equal(writes[0].status, 200);
  assert.match(writes[1].chunk, /workspace-a/);
});

test('OpenAPI metrics schema names the internal snapshot and its bounded fields', () => {
  const spec = observabilityOpenApiDocument();
  const response = spec.components.schemas.ResponseMetrics;
  assert.equal(response.properties.data.properties.internal.$ref, '#/components/schemas/InternalMetrics');
  const internal = spec.components.schemas.InternalMetrics;
  assert.deepEqual(Object.keys(internal.properties).sort(), [
    'alertEvaluation', 'approval_requests_total', 'database', 'db_errors_total', 'denied_actions_total',
    'droppedEvents', 'eventWrites', 'graph_operations_total', 'projectionFailures',
    'retrieval_latency_ms', 'rust_fallback_total', 'subscriberCount', 'summary',
    'verification_latency_ms', 'workspaceId',
  ].sort());
  assert.equal(internal.additionalProperties, false);
});
