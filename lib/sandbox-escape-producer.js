'use strict';

// #2505 G: the production producer of sandbox escape attempts, kept out of
// sandboxRunner.js on purpose — that file is over the large-file threshold
// (issue #328) and may not grow further.
//
// The runner is passed in rather than required: `lib/` is an inner ring and
// may not point its edge at the outer `sandboxRunner.js` (layer check).
// Every AB6 block/quarantine verdict is recorded to the supplied graph, so no
// caller has to remember to persist `meta.ab6` itself. Recording is opt-in on
// `opts.graph` (absent means plain runner behavior), bounded to escape
// verdicts only, and can never break execution: the ledger swallows its own
// failures, and a missing graph is a no-op.

function createSandboxEscapeProducer({ runSandboxed } = {}) {
  if (typeof runSandboxed !== 'function') {
    throw new TypeError('createSandboxEscapeProducer requires a runSandboxed runner');
  }

  function runSandboxedWithEscapeRecording(source, bindings = {}, opts = {}) {
    const result = runSandboxed(source, bindings, opts);
    if (opts.graph) {
      try {
        const { recordSandboxVerdict } = require('./sandbox-escape-ledger');
        recordSandboxVerdict({
          graph: opts.graph,
          verdict: result.meta && result.meta.ab6,
          workspaceId: opts.workspaceId,
          sourceRef: opts.sourceRef,
        });
      } catch (_) {
        // Observation must not become a new way for a sandbox call to fail.
      }
    }
    return result;
  }

  return Object.freeze({ runSandboxedWithEscapeRecording });
}

module.exports = {
  createSandboxEscapeProducer,
};
