'use strict';

/**
 * Give every kernel an observability sink, not just the ones inside an HTTP
 * server.
 *
 * `emitGateTelemetry()` writes through `kernel?.observability?.recordGateDecision?.()`
 * wrapped in `try { ... } catch (_) {}`. That shape is correct -- telemetry must
 * never revise a gate decision that has already been made -- but it also means
 * an unattached sink fails in total silence. Until this module existed, the only
 * place that assigned `kernel.observability` was the HTTP observability runtime,
 * lazily, with server.js as its sole caller. Every MCP tool call and every CLI
 * invocation therefore evaluated gates, made decisions, and recorded none of
 * them.
 *
 * The sink is built on first read rather than in the constructor: a kernel that
 * never emits telemetry should not pay for a migration run, and `huqan --help`
 * should not touch the schema.
 */

const { createObservabilityService } = require('./service');
const { stampInstrumentedSince } = require('./instrumentation-marker');

/**
 * The graph's SQLite handle is the store the rest of the observability schema
 * already lives in -- the operator store shows `observability_events` sitting
 * beside `nodes` and `edges` in one file. Reaching for the private field is
 * deliberate and confined to this line: the alternative is a public accessor
 * whose only caller would be this module.
 */
function sinkDatabase(kernel) {
  return kernel?.graph?._db || null;
}

function attachObservabilitySink(kernel, { createService = createObservabilityService } = {}) {
  if (!kernel) return kernel;
  // undefined: not built yet. null: this store cannot carry one, and asking
  // again will not change that.
  let service;

  Object.defineProperty(kernel, 'observability', {
    configurable: true,
    enumerable: false,
    get() {
      if (service !== undefined) return service;
      const db = sinkDatabase(kernel);
      if (!db) {
        // JSON mode, or better-sqlite3 unavailable. Telemetry stays a no-op,
        // and the usage report reads the missing stamp as "not instrumented"
        // rather than as "never used".
        service = null;
        return service;
      }
      try {
        service = createService({ db });
        stampInstrumentedSince(db);
      } catch (_) {
        // A store that cannot host the observability schema -- read-only file,
        // failed migration -- must not break the operation the caller was
        // actually performing.
        service = null;
      }
      return service;
    },
    set(value) {
      // server.js builds its own service with the HTTP runtime's configuration
      // and assigns it. A getter-only property would turn that into a crash.
      Object.defineProperty(kernel, 'observability', {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    },
  });

  return kernel;
}

module.exports = { attachObservabilitySink };
