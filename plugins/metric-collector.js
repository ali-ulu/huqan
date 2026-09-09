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
 *   - 'export': writes the current aggregate to a JSON file (default
 *     <user-data>/gate-telemetry.json; repo benchmarks/ stays a valid
 *     explicit target). This is a new,
 *     separate artifact -- it deliberately does not touch
 *     benchmarks/results.json, which is bench.js's own performance-timing
 *     output with an unrelated schema; writing gate counts into that file
 *     would corrupt it for its actual consumers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPathError, isPathWithinRoot, resolvePathWithinRoot } = require('../lib/path-safety');
const { resolveGateTelemetryPath } = require('../persistencePaths');

// User-data default, resolved lazily per call (see defaultOutputPath): the
// install dir is never written unless the caller explicitly asks for it
// (H-09, #1982).
const DEFAULT_OUTPUT_PATH = resolveGateTelemetryPath();

function defaultOutputPath(environment = process.env) {
  return resolveGateTelemetryPath(environment);
}
const REPO_ROOT = path.join(__dirname, '..');
// Dev fallback only: the repo checkout's own benchmarks/ stays a valid
// explicit target, but it is no longer the default -- a read-only install
// cannot be written to.
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

/**
 * Pick the enforcement boundary for a caller-supplied output path.
 *
 * Repo-contained paths stay bounded to benchmarks/ exactly as before (#1280):
 * an explicit benchmarks/results.json-adjacent target is fine, but
 * '<repo>/package.json' is rejected even though it sits under cwd, because
 * fs.writeFileSync would silently overwrite it. Anything outside the repo is
 * a user-data-style target and is accepted under the longest matching root
 * of the default telemetry dir, the OS temp dir, or the working directory --
 * so tmp/cwd exports work on a read-only install. Anything else fails closed.
 */
function resolveExportRoot(candidatePath) {
  const absolute = path.resolve(candidatePath);
  if (isPathWithinRoot(REPO_ROOT, absolute)) {
    return BENCHMARKS_ROOT;
  }
  const roots = [path.dirname(defaultOutputPath()), os.tmpdir(), process.cwd()]
    .map((root) => path.resolve(root))
    .filter((root) => isPathWithinRoot(root, absolute))
    .sort((left, right) => right.length - left.length);
  if (!roots.length) {
    throw createPathError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'Path escapes allowed root',
      path.dirname(defaultOutputPath()),
      absolute,
    );
  }
  return roots[0];
}

function resolveOutputPath(outputPath) {
  const candidate = outputPath || defaultOutputPath();
  return resolvePathWithinRoot(resolveExportRoot(candidate), candidate, { allowMissing: true });
}

module.exports = {
  name: 'metric-collector',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'metricCollector',
      command: 'metric-collector',
      description: 'Aggregates gate-decision telemetry (afterGateDecision) and can export it as a JSON file under the user-data dir (repo benchmarks/ as dev fallback).',
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

module.exports._test = { ensureMetricsState, recordDecision, resolveOutputPath, resolveExportRoot, defaultOutputPath, DEFAULT_OUTPUT_PATH, BENCHMARKS_ROOT };
