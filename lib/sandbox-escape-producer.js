'use strict';

// #2505 G: the production producer of sandbox escape attempts, kept out of
// sandboxRunner.js on purpose — that file is over the large-file threshold
// (issue #328) and may not grow further.
//
// Every AB6 block/quarantine verdict is recorded to the supplied graph, so no
// caller has to remember to persist `meta.ab6` itself. Recording is opt-in on
// `opts.graph` (absent means plain `runSandboxed` behavior), bounded to
// escape verdicts only, and can never break execution: the ledger swallows
// its own failures, and a missing graph is a no-op.

const { runSandboxed } = require('../sandboxRunner');

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

module.exports = {
  runSandboxedWithEscapeRecording,
};
