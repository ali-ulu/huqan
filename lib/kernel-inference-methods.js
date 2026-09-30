'use strict';

/**
 * Kernel method group for the inference runtime (#3038).
 *
 * Kept in its own file (like the other method groups, installed onto
 * Kernel.prototype by lib/kernel-method-install.js) so kernel.js stays under
 * the file-size ratchet. Both this module and lib/inference-runtime.js are
 * Core, so the require is a same-layer edge.
 *
 * The admission seam is injected here, not created here: `admitDerivedRecord`
 * needs `ingestCandidateClaim`, and `kernel.ingestCandidateClaim` is the
 * existing candidate ingress. A derived candidate therefore travels the same
 * path a hand-authored claim does -- there is no second admission authority and
 * no direct graph write. `_inferenceAdmissionSeam` is a single overridable
 * method so the admission behaviour can be exercised without monkey-patching
 * the runtime module.
 */

const { deriveFromRules, proveFromRules } = require('./inference-runtime');
const { installKernelMethods } = require('./kernel-method-install');

function install(Kernel) {
  class KernelInferenceMethods {
    /**
     * Derive facts from a general rule set over supplied ground facts.
     *
     * Read-only by default: the derivation is returned provisional and nothing
     * reaches the graph. It only becomes canonical if the caller opts into
     * admission (`opts.admit === true`) and the existing candidate ingress
     * accepts the claim.
     */
    derive(input = {}, opts = {}) {
      const result = deriveFromRules(input, {
        now: opts.now,
        limits: opts.limits,
        admission: opts.admit === true ? this._inferenceAdmissionSeam() : null,
      });
      if (result.status === 'invalid') {
        return this._inferenceFailure('derive', result.error);
      }
      return {
        ok: true,
        type: 'derive',
        data: {
          status: result.status,
          stoppedReason: result.stoppedReason,
          rounds: result.rounds,
          budget: result.budget,
          stats: result.stats,
          snapshot: result.snapshot,
          derivedFacts: result.derivedFacts,
          admission: result.admission,
        },
        evidence: [],
        error: null,
        meta: { inferredBy: 'inference-runtime', backend: this.graph && this.graph._sqliteOptions ? 'sqlite' : 'json' },
      };
    }

    /** Bounded query-time proof of one ground fact over a rule set. */
    prove(input = {}, opts = {}) {
      const result = proveFromRules(input, { limits: opts.limits });
      if (result.status === 'invalid') {
        return this._inferenceFailure('prove', result.error);
      }
      return {
        ok: true,
        type: 'prove',
        data: {
          status: result.status,
          reason: result.reason,
          operations: result.operations,
          proof: result.proof,
        },
        evidence: [],
        error: null,
        meta: { inferredBy: 'inference-runtime', backend: this.graph && this.graph._sqliteOptions ? 'sqlite' : 'json' },
      };
    }

    _inferenceFailure(type, error) {
      return {
        ok: false,
        type,
        data: null,
        evidence: [],
        error: error || { code: 'INFERENCE_FAILED', message: 'inference failed' },
        meta: { inferredBy: 'inference-runtime' },
      };
    }

    _inferenceAdmissionSeam() {
      return { ingestCandidateClaim: this.ingestCandidateClaim.bind(this) };
    }
  }
  installKernelMethods(Kernel, KernelInferenceMethods);
}

module.exports = { install };
