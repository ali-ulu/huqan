'use strict';

/**
 * The learn pipeline's post-commit step (#3088).
 *
 * Split out of lib/learn-use-case.js without behaviour change. It is invoked
 * with the learn kernel as `this`, so it stays inside executeLearn's
 * admission-gated scope: the writes have already passed kernel.learn's admit()
 * gate, and this step only fans out the afterLearn/rust notification, performs
 * the deferred persistence, and builds the terminal learn result.
 *
 * Every kernel member it touches is reached through `this` (the module-owned
 * receiver), never through a foreign binding, so moving it introduces no
 * private-reach-through (check-module-boundary).
 *
 * It is deliberately sink-free. (#2198) kept executeLearn whole because it
 * holds the knowledge family's eight graph sinks (addNode 3, addEdge 4,
 * addTag 1) and their admission is a *transitive* claim: the entry module
 * exports only runLearnUseCase and kernel.js is its only caller, so every sink
 * sits behind kernel.learn's admit(). Giving a sink-bearing step its own
 * export would be a second way into the sinks. This step performs no graph
 * sink, so extracting it leaves that claim intact: the sinks stay in the entry
 * and the mutation-admission ledger keeps its recorded counts.
 *
 * @param {string} text
 * @param {object} opts
 * @param {object} state the values executeLearn accumulated
 * @returns {object} the `this.ok('learn', ...)` result
 */
function commitLearnOutcome(text, opts, state) {
  const {
    conflicts,
    alternatives,
    metadata,
    workspaceId,
    admission,
    learned,
    parsed,
    evidence,
    provenance,
    provenanceWarnings,
    afterCommitEffects,
  } = state;

  // #212's receipt-exporter.js needs the receipt on afterLearn -- it was
  // previously absent from this payload entirely (only present on learn()'s
  // own return value), so no afterLearn plugin could ever observe it.
  const emitAfterLearn = () => this.plugins.emit('afterLearn', {
    text,
    conflicts,
    alternatives,
    opts: { ...metadata, workspaceId },
    admission: this._admissionReceiptDetails(admission),
  });
  const notifyRust = () => {
    if (this._rust) {
      this._rust.learn(text).catch((e) => { console.error("[Kernel] Rust learn hatası:", e?.message || e); });
    }
  };
  if (afterCommitEffects) {
    afterCommitEffects.push(emitAfterLearn, notifyRust);
  } else {
    emitAfterLearn();
    notifyRust();
  }

  if (learned > 0) {
    // #1747 batch persistence: `deferSave` suppresses the per-learned-line
    // full-graph save; the document caller (Kernel.learnDocument) flushes
    // the graph once at the end. Default behaviour is unchanged.
    if (!opts._durableMutationTransaction && opts.deferSave !== true) {
      try { this.graph.save(); } catch (e) { console.error("[Kernel] Graph save hatası:", e.message); }
    }
    if (typeof setImmediate !== 'undefined') setImmediate(() => this._autoMaintain());
  }

  return this.ok('learn', {
    learned,
    skipped: parsed.length - learned,
    conflicts,
    alternatives,
    provenanceWarnings,
    admission: admission || null,
  }, evidence, {
    provenance: provenance || null,
    provenanceWarnings,
    trustPolicyVersion: provenance ? provenance.trustPolicyVersion : undefined,
    admission: admission || null,
  });
}

module.exports = { commitLearnOutcome };
