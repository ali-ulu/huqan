'use strict';

/**
 * Make sure a kernel has somewhere to record gate decisions.
 *
 * `emitGateTelemetry()` writes through `kernel?.observability?.recordGateDecision?.()`
 * wrapped in `try { ... } catch (_) {}`. That shape is correct -- telemetry must
 * never revise a decision already made -- but it also means a missing sink fails
 * in total silence. And the sink was missing: the only non-benchmark assignment
 * of `kernel.observability` in the tree was in lib/observability/server-runtime.js,
 * inside a lazy getService() whose sole caller is server.js. Every gate decision
 * made by the MCP process and by the CLI was evaluated, acted on, and recorded
 * nowhere.
 *
 * The operator store shows the cost: 246 audit events, 131 approvals and 61
 * learn events, with `observability_events` empty and the observability schema
 * already migrated. The evidence that answers "has this capability ever run?"
 * was being produced and dropped.
 *
 * Attachment happens on the first emission rather than in the kernel
 * constructor: a kernel that never emits telemetry should not pay for a
 * migration run, and `huqan --help` should not touch the schema.
 */

const { createObservabilityService } = require('./service');
const { stampInstrumentedSince } = require('./instrumentation-marker');

/**
 * The graph's SQLite handle is the store the observability schema already lives
 * in -- in the operator store `observability_events` sits beside `nodes` and
 * `edges` in one file. Reaching for the private field is deliberate and confined
 * to this line; a public accessor would have exactly one caller.
 *
 * Reading through `kernel.graph` also means a KernelV2 facade resolves to the
 * same handle as the Kernel it wraps, so it does not matter which of the two an
 * emitter was handed.
 */
function sinkDatabase(kernel) {
  return kernel?.graph?._db || null;
}

/**
 * Return this kernel's sink, building and attaching one the first time. The
 * result is stored on the kernel -- including `null` -- so a store that cannot
 * host a sink is asked once, not on every gate decision.
 *
 * The property is written as an ordinary value, which is what lets server.js
 * keep replacing it with the service it builds from the HTTP runtime's own
 * configuration.
 */
function ensureObservabilitySink(kernel) {
  if (!kernel || typeof kernel !== 'object') return null;
  if (kernel.observability !== undefined) return kernel.observability;

  const db = sinkDatabase(kernel);
  if (!db) {
    // JSON mode, or better-sqlite3 unavailable. Telemetry stays a no-op here,
    // and the usage report reads the missing stamp as "not instrumented"
    // rather than as "never used".
    kernel.observability = null;
    return null;
  }

  try {
    kernel.observability = createObservabilityService({ db });
    stampInstrumentedSince(db);
  } catch (_) {
    // A store that cannot host the observability schema -- a read-only file, a
    // failed migration -- must not break the operation the caller was actually
    // performing.
    kernel.observability = null;
  }
  return kernel.observability;
}

module.exports = { ensureObservabilitySink };
