'use strict';

/**
 * Provenance for writes the system makes on its own behalf.
 *
 * Two paths use this: autonomous mutation (_autoThinkTick, dream, selfEvolve,
 * _crossLink) and the plugin-facing proposeEdge/proposeNode surface. Neither
 * has an external source to attribute, so the provenance is synthetic -- but
 * synthetic is not the same as ungoverned: it is fed into the same admission
 * gate as a user write, which by default returns 'review' for a low-trust
 * background actor and so prevents a silent canonical write.
 *
 * This lived inline in kernel.js until the trust policy had to be applied here,
 * at which point the file-size ratchet (#328) was correct that it wanted to be
 * its own module rather than another twenty lines of kernel.
 */

const { loadTrustPolicy, applyTrustPolicyToProvenance } = require('./trust-policy');

/**
 * @param {string} source            the background source name, e.g. 'autoThink', 'plugin'
 * @param {string} workspaceId
 * @param {object} extra             caller overrides, merged last
 * @param {object} opts
 * @param {string} opts.contractVersion
 * @param {string} [opts.trustPolicyPath]
 * @returns {object} provenance, scored by the trust policy where possible
 */
function buildBackgroundProvenance(source, workspaceId = 'default', extra = {}, opts = {}) {
  const base = {
    provenanceId: `prov_bg_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    source: `background:${source}`,
    sourceType: 'background_inference',
    sourceRef: `kernel.${source}`,
    actor: `kernel-background:${source}`,
    workspaceId,
    trustPolicyVersion: opts.contractVersion,
    ...extra,
  };

  // Before this, the object above was returned as-is, so these two paths never
  // reached the trust policy at all: no confidence was computed for them, and a
  // plugin edge scored the same as a kernel self-write, which is to say neither
  // was scored. The learn path has always gone through buildProvenance.
  //
  // Guarded on purpose. This runs on autonomous mutation paths, and an
  // unreadable or malformed policy file must not turn a background write into a
  // throw; returning the unscored object is the pre-existing behaviour, and the
  // admission gate still sees it.
  try {
    const applied = applyTrustPolicyToProvenance(base, loadTrustPolicy(opts.trustPolicyPath));
    return applied && applied.provenance ? applied.provenance : base;
  } catch (_) {
    return base;
  }
}

/**
 * The provenance-shaped fields a plugin write may carry.
 *
 * Edge `meta` is namespaced and bounded to `entityResolution` by
 * lib/graph-record-utils.js, deliberately, so source-version detail cannot ride
 * there -- and should not: it describes where the claim came from, which is
 * provenance's job. This is the allowlist proposeEdge/proposeNode forward, so a
 * plugin that has pinned its source can say so without every caller re-listing
 * the fields.
 */
function provenanceFieldsFrom(opts = {}) {
  const fields = {
    sourceType: opts.sourceType || 'plugin',
    sourceRef: opts.sourceRef || '',
    actor: opts.actor || opts.sessionId || 'plugin',
  };
  // Absent stays absent: an empty sourceVersion would read as "pinned, to
  // nothing", and an empty contentHash as "hashed, to nothing".
  for (const key of ['sourceSubType', 'sourceVersion', 'sourceVersionKind', 'contentHash', 'contentHashAlgorithm']) {
    if (opts[key]) fields[key] = opts[key];
  }
  return fields;
}

module.exports = { buildBackgroundProvenance, provenanceFieldsFrom };
