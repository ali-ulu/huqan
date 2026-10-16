'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservabilityInternalMetrics } = require('../lib/observability/internal-metrics');

test('O4 internal metrics expose bounded latency percentiles and counters', () => {
  const metrics = createObservabilityInternalMetrics();
  const workspace = 'workspace-o4';

  for (const value of [10, 20, 30, 40, 50]) metrics.recordVerificationLatency(workspace, value);
  for (const value of [5, 15, 25, 35]) metrics.recordRetrievalLatency(workspace, value);

  metrics.recordGraphOperation(workspace, 'read');
  metrics.recordGraphOperation(workspace, 'write');
  metrics.recordGraphOperation(workspace, 'delete');
  metrics.recordGraphOperation(workspace, 'traverse');
  metrics.recordDeniedAction(workspace, 'workspace_boundary_violation');
  metrics.recordDeniedAction(workspace, 'workspace_boundary_violation');
  metrics.recordApprovalRequest(workspace, 'allow');
  metrics.recordApprovalRequest(workspace, 'review');
  metrics.recordApprovalRequest(workspace, 'block');
  metrics.recordDbError(workspace, 'SQLITE_BUSY');
  metrics.recordRustFallback(workspace);

  const snapshot = metrics.snapshot(workspace, 0);
  assert.deepEqual(snapshot.verification_latency_ms, { count: 5, p50: 30, p95: 50, p99: 50 });
  assert.deepEqual(snapshot.retrieval_latency_ms, { count: 4, p50: 15, p95: 35, p99: 35 });
  assert.deepEqual(snapshot.graph_operations_total, { read: 1, write: 1, delete: 1, traverse: 1 });
  assert.deepEqual(snapshot.denied_actions_total, { workspace_boundary_violation: 2 });
  assert.deepEqual(snapshot.approval_requests_total, { allow: 1, review: 1, block: 1 });
  assert.deepEqual(snapshot.db_errors_total, { sqlite_busy: 1 });
  assert.equal(snapshot.rust_fallback_total, 1);
});

test('database wrapper records error type without swallowing the original error', () => {
  const metrics = createObservabilityInternalMetrics();
  const failure = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });

  assert.throws(
    () => metrics.measureDatabase('workspace-db', () => { throw failure; }),
    error => error === failure,
  );

  assert.deepEqual(metrics.snapshot('workspace-db', 0).db_errors_total, { sqlite_busy: 1 });
});

test('metric labels stay bounded when callers provide untrusted reason cardinality', () => {
  const metrics = createObservabilityInternalMetrics();
  for (let index = 0; index < 40; index += 1) {
    metrics.recordDeniedAction('workspace-labels', `reason-${index}`);
  }
  const denied = metrics.snapshot('workspace-labels', 0).denied_actions_total;
  assert.ok(Object.keys(denied).length <= 32);
  assert.ok(denied.other >= 1);
});
