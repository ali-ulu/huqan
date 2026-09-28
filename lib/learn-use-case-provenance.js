'use strict';

/**
 * Whether the caller actually named a source.
 *
 * The strictProvenance gate used `hasProvenanceInput`, which is a much broader
 * question -- "is there anything here worth normalizing?" -- and answers yes for
 * `workspaceId`, `actor` and `timestamp`. Those are routine call parameters,
 * not provenance: a caller passing only `workspaceId` satisfied a gate whose
 * own message says "provenance is required", and the write proceeded on a
 * provenance record synthesized from an empty object.
 *
 * A source means a `provenance` object carrying something, or an explicit
 * sourceRef / sourceType. `sourceTitle` alone is a label without a source, so
 * it does not qualify on its own.
 *
 * Split out of lib/learn-use-case.js (#3088) without behaviour change: this is
 * the pure provenance-resolvability predicate, and it reaches no graph sink.
 *
 * @param {object} opts
 * @returns {boolean}
 */
function hasRealProvenance(opts = {}) {
  const provenance = opts.provenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)
      && Object.values(provenance).some(value => value !== undefined && value !== null && String(value).trim() !== '')) {
    return true;
  }
  return Boolean(
    (typeof opts.sourceRef === 'string' && opts.sourceRef.trim())
    || (typeof opts.sourceType === 'string' && opts.sourceType.trim()),
  );
}

module.exports = { hasRealProvenance };
