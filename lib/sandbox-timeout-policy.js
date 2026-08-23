'use strict';

/**
 * AB6's timeout ceiling: one value decides, and the others derive from it.
 *
 * Three limits used to disagree (#1113). `MAX_TIMEOUT_MS` was exported as the
 * public maximum, `policy.maximumTimeoutMs` was validated, clamped and stored
 * as the operator's knob, and an unconditional `context.timeoutMs > 1000` in
 * the classifier decided every case before either could apply.
 *
 * The consequences ran both ways. Requesting exactly the exported maximum was
 * blocked, so `MAX_TIMEOUT_MS` was the first *rejected* value rather than the
 * largest accepted one -- and `normalizeSandboxInput` clamped an oversized
 * request down to it, which accomplished nothing except reporting a timeout the
 * caller never asked for: a request for 60000 was refused with "Timeout 5000ms
 * exceeds safe threshold", naming a number absent from the request. Meanwhile
 * an operator who raised the knob to 3000 saw no change in behaviour and no
 * indication why, because every value they had just authorised was still
 * blocked by the check that ran first.
 *
 * So: the operator's ceiling decides, bounded by the hard cap it may not
 * exceed, and the default stands in when no policy is configured. The boundary
 * is inclusive -- the value that names the limit is an accepted one.
 */

/** The hard cap. A policy may not raise the accepted timeout above this. */
const MAX_TIMEOUT_MS = 5000;

/**
 * The ceiling when the operator has configured none. This is the 1000 that used
 * to be hardcoded in the decision, kept as the default so a caller that passes
 * no policy sees the behaviour it always saw.
 */
const DEFAULT_SAFE_TIMEOUT_MS = 1000;

/** The effective ceiling: the operator's, bounded by the hard cap. */
function resolveTimeoutCeiling(policy) {
  const configured = policy && policy.maximumTimeoutMs;
  if (typeof configured === 'number' && configured > 0) {
    return Math.min(MAX_TIMEOUT_MS, configured);
  }
  return DEFAULT_SAFE_TIMEOUT_MS;
}

/**
 * Which ceiling applied, so a finding can tell an operator "you exceeded the
 * limit I configured" apart from "you exceeded a default I never changed".
 */
function describeTimeoutCeiling(policy) {
  const configured = policy && policy.maximumTimeoutMs;
  return (typeof configured === 'number' && configured > 0) ? 'policy' : 'default safe';
}

module.exports = {
  MAX_TIMEOUT_MS,
  DEFAULT_SAFE_TIMEOUT_MS,
  resolveTimeoutCeiling,
  describeTimeoutCeiling,
};
