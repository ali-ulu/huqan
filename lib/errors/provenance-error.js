'use strict';

/**
 * ProvenanceError lives here rather than in kernel.js to keep the core
 * dependency graph acyclic (issue #327).
 *
 * lib/provenance-ingest.js has to throw this error, and it used to reach it via
 * a lazy `require('../kernel')` inside a try/catch. That single edge closed four
 * cycles through the correctness core:
 *
 *   kernel -> provenance-ingest -> kernel
 *   graph -> conflict-detector -> provenance-ingest -> kernel -> graph
 *   conflict-detector -> provenance-ingest -> kernel -> conflict-detector
 *   graph -> conflict-detector -> provenance-ingest -> kernel -> rustGraph -> graph
 *
 * The error is a leaf value with no dependencies of its own, so owning it in a
 * leaf module lets both kernel.js and provenance-ingest.js depend downward on
 * it instead of on each other. kernel.js re-exports it, so
 * `Kernel.ProvenanceError` and `error instanceof Kernel.ProvenanceError` keep
 * working for existing callers.
 */

class ProvenanceError extends Error {
  constructor(message = 'provenance is required when strictProvenance is true') {
    super(message);
    this.name = 'ProvenanceError';
    this.code = 'PROVENANCE_REQUIRED';
  }
}

module.exports = { ProvenanceError };
