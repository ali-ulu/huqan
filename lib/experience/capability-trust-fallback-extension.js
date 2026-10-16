'use strict';

/**
 * Experience — Capability Trust fallback extension (design comment on
 * #2385, R3 Phase 9).
 *
 * Kept in its own file rather than inline in `capability-trust.js` purely
 * for `check:file-size` budget reasons (issue #328's 400-line ratchet).
 * This is NOT a parallel ladder or a separate ownership boundary —
 * `createFallbackExtension()` is called from inside
 * `createCapabilityTrustRegistry()` and operates on that same registry's
 * private `records` Map and closures (`compositeKey`, `toPublicEntry`), so
 * the one function below is exactly as much part of the Capability Trust
 * ladder as `rebindProcedure`/`applyOperatorBlock` are; it is simply
 * defined in a sibling module for line-budget reasons.
 */

/**
 * Anti-erosion counter: caller already decided this capability structurally
 * matched a refused request and fallback was used anyway.
 * Never auto-creates, unlike recordRun() — a capability nobody registered
 * is not "bypassed," it simply does not exist yet.
 */
function createFallbackExtension({ records, compositeKey, toPublicEntry }) {
  function incrementFallbackPreferredOverCount({ workspaceId, capabilityId } = {}) {
    const record = records.get(compositeKey(workspaceId, capabilityId));
    if (!record) return { ok: false, code: 'not_found' };
    record.fallbackPreferredOverCount = (record.fallbackPreferredOverCount || 0) + 1;
    return { ok: true, entry: toPublicEntry(record) };
  }

  return Object.freeze({ incrementFallbackPreferredOverCount });
}

module.exports = Object.freeze({ createFallbackExtension });
