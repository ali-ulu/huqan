'use strict';

// Kernel learn-input preparation moved out of kernel.js (#2122): the async
// preIngest pass, learn metadata and edge options, and provenance
// normalisation. None of them writes: the admission-gated learn() path and
// its audit chokepoint stay in kernel.js. Installed on Kernel.prototype by
// kernel.js with the descriptors they had as class methods; `this` is the
// Kernel instance.

const { buildProvenance } = require('./provenance-ingest');
const { buildLearnEdgeOptions } = require('./learn-edge-options');
const { installKernelMethods } = require('./kernel-method-install');

class KernelLearnInputMethods {
  /**
   * Async pre-ingest pass, run by learnAsync() before the synchronous
   * learn() pipeline is entered. Handlers may do I/O; a rejection aborts
   * the learn entirely (fail-closed), and the possibly-rewritten
   * {text, opts} is what learn() then receives.
   *
   * This is the answer to #348 that does *not* require making the whole
   * kernel API async: async validation happens here, ahead of learn(),
   * rather than inside the synchronous beforeLearn hook.
   */
  async _runPreIngest(text, opts = {}) {
    const payload = { text, opts: { ...opts } };
    if (!this.plugins || typeof this.plugins.emitStrictAsync !== 'function') return payload;
    if (!this.plugins._handlers || !this.plugins._handlers.preIngest || this.plugins._handlers.preIngest.length === 0) {
      return payload;
    }
    const result = await this.plugins.emitStrictAsync('preIngest', payload);
    // A handler that returns something non-payload-shaped would otherwise
    // reproduce exactly the silent corruption #348 is about, one layer up.
    if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
      const error = new Error('preIngest hook returned a value without a string "text" field; refusing to learn from it');
      error.code = 'PRE_INGEST_INVALID_PAYLOAD';
      throw error;
    }
    return result;
  }

  _resolveLearnMetadata(opts = {}) {
    const sourceType = typeof opts.sourceType === 'string' ? opts.sourceType.trim() : '';
    const sourceRef = typeof opts.sourceRef === 'string' ? opts.sourceRef.trim() : '';
    const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
    const evidenceType = typeof opts.evidenceType === 'string' ? opts.evidenceType.trim() : '';
    const explicitCompanyMode = typeof opts.companyMode === 'boolean' ? opts.companyMode : this.hasCapability('companyMode');
    const companyMode = explicitCompanyMode && this.hasCapability('companyMode');
    return {
      sourceType,
      sourceRef,
      sessionId,
      evidenceType,
      companyMode,
    };
  }

  _learnEdgeOptions(base, meta, text) {
    return buildLearnEdgeOptions(base, meta, text);
  }

  _normalizeProvenanceInput(provenanceInput, opts = {}) {
    if (!provenanceInput && !opts.sourceType && !opts.sourceRef && !opts.sourceTitle && !opts.actor && !opts.timestamp && !opts.workspaceId) {
      return { provenance: null, warnings: [] };
    }

    return buildProvenance(provenanceInput || {}, {
      strictProvenance: this.strictProvenance,
      trustPolicy: opts.trustPolicy,
      trustPolicyPath: opts.trustPolicyPath,
      sourceType: opts.sourceType,
      sourceSubType: opts.sourceSubType,
      sourceRef: opts.sourceRef,
      sourceTitle: opts.sourceTitle,
      actor: opts.actor,
      timestamp: opts.timestamp,
      workspaceId: opts.workspaceId,
    });
  }
}

function install(Kernel) {
  installKernelMethods(Kernel, KernelLearnInputMethods);
}

module.exports = { install };
