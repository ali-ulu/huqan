'use strict';
// #2147: the observability service's closed vocabularies and window bounds.
const { normalizeInteger } = require('./helpers');
const MAX_ALERT_LIMIT = 100;
const DEFAULT_METRIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_METRIC_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function normalizeMetricWindow(windowMs) {
  return Math.min(MAX_METRIC_WINDOW_MS, Math.max(1_000, normalizeInteger(windowMs) ?? DEFAULT_METRIC_WINDOW_MS));
}
const EVENT_TYPES = Object.freeze([
  'run_started',
  'run_finished',
  'step_finished',
  'gate_decision',
  'queue_enqueued',
  'queue_started',
  'queue_finished',
  'alert_firing',
  'alert_acknowledged',
  'alert_resolved',
]);
const ALERT_METRICS = Object.freeze([
  'success_rate',
  'avg_latency_ms',
  'p95_latency_ms',
  'token_total',
  'cost_micros',
  'error_count',
  'queue_depth',
]);
const ALERT_OPERATORS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq']);

module.exports = Object.freeze({
  MAX_ALERT_LIMIT, DEFAULT_METRIC_WINDOW_MS, MAX_METRIC_WINDOW_MS, normalizeMetricWindow,
  EVENT_TYPES, ALERT_METRICS, ALERT_OPERATORS,
});
