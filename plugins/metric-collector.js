'use strict';

/**
 * metric-collector (#212).
 *
 * afterGateDecision hook: aggregates gate-decision telemetry (see
 * lib/gate-telemetry.js for why 'afterGateDecision' -- a brand new event --
 * exists and which three gate call sites actually emit it: no gate
 * decision was observable by any plugin before that module existed).
 *
 * Exposes a 'metricCollector' capability with two actions:
 *   - 'summary': returns the in-memory aggregate (counts by source, by
 *     decision, total events since kernel start).
 *   - 'export': writes the current aggregate to a JSON file under
 *     benchmarks/ (default benchmarks/gate-telemetry.json). This is a new,
 *     separate artifact -- it deliberately does not touch
 *     benchmarks/results.json, which is bench.js's own performance-timing
 *     output with an unrelated schema; writing gate counts into that file
 *     would corrupt it for its actual consumers.
 */

const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../lib/path-safety');

const DEFAULT_OUTPUT_PATH = path.join(__dirname, '..', 'benchmarks', 'gate-telemetry.json');
// Bounded to benchmarks/, not REPO_ROOT: a caller-controlled outputPath
// validated only against REPO_ROOT can target any .json file in the repo
// (package.json, memory.json, even benchmarks/results.json -- bench.js's own
// unrelated-schema output this module's own docs above say it must not
// touch), and fs.writeFileSync silently overwrites whatever it finds (#1280).
const BENCHMARKS_ROOT = path.join(__dirname, '..', 'benchmarks');

function ensureMetricsState(kernel) {
  if (!kernel._gateMetricsState) {
    kernel._gateMetricsState = {
      total: 0,
      bySource: {},
      byDecision: {},
      startedAt: new Date().toISOString(),
      lastEventAt: null,
    };
  }
  return kernel._gateMetricsState;
}

function recordDecision(metricsState, event) {
  const source = (event && event.source) || 'unknown';
  const decision = (event && event.decision) || 'unknown';

  metricsState.total += 1;
  metricsState.bySource[source] = (metricsState.bySource[source] || 0) + 1;
  metricsState.byDecision[decision] = (metricsState.byDecision[decision] || 0) + 1;
  metricsState.lastEventAt = new Date().toISOString();
}

function resolveOutputPath(outputPath) {
  return resolvePathWithinRoot(BENCHMARKS_ROOT, outputPath || DEFAULT_OUTPUT_PATH, { allowMissing: true });
}

module.exports = {
  name: 'metric-collector',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'metricCollector',
      command: 'metric-collector',
      description: 'Aggregates gate-decision telemetry (afterGateDecision) and can export it as a JSON file under benchmarks/.',
    },
  ],

  afterGateDecision(kernel, data) {
    const metricsState = ensureMetricsState(kernel);
    recordDecision(metricsState, data);
  },

  run(kernel, input = {}) {
    const action = String(input.action || 'summary').toLowerCase();
    const metricsState = ensureMetricsState(kernel);

    if (action === 'summary') {
      return { ok: true, metrics: { ...metricsState, bySource: { ...metricsState.bySource }, byDecision: { ...metricsState.byDecision } } };
    }

    if (action === 'export') {
      let outputPath;
      try {
        outputPath = resolveOutputPath(input.outputPath);
      } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'METRIC_EXPORT_PATH_INVALID' };
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(metricsState, null, 2));
      return { ok: true, outputPath };
    }

    return { ok: false, error: `Unsupported metric-collector action: ${action}` };
  },
};

module.exports._test = { ensureMetricsState, recordDecision, resolveOutputPath, DEFAULT_OUTPUT_PATH };
