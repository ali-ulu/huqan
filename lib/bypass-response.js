'use strict';

// #2505 bypass response, decision support only: given a windowed bypass state
// (lib/bypass-signal-state.js) and an explicit policy, say per fingerprint
// whether the run deserves review, a block, or nothing -- and whether an
// emergency stop belongs before an operator.
//
// The policy arrives as an argument and has no defaults: thresholds invented
// by an implementer would hand the user a policy disguised as code. The
// Codex control-set design proposes refused-retry review after 2 and block
// after 3, block plus proposal on the first escape or widening, and
// deployment-defined egress handling; those numbers live in tests and docs
// as the proposed starter, never here.
//
// Nothing here acts. A `block-and-propose` answer is a recommendation the
// operator surfaces consume through approval; unexpected egress explicitly
// stays `none` with its reason, because its review/block policy is the
// deployment's, not this function's.

const RESPONSE_VERSION = 'huqan-bypass-response-v1';

function checkCount(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('policy must be an object');
  }
  const retry = policy.refusedRetry && typeof policy.refusedRetry === 'object' ? policy.refusedRetry : null;
  if (!retry) throw new TypeError('policy.refusedRetry is required');
  const reviewAfter = checkCount(retry.reviewAfter, 'policy.refusedRetry.reviewAfter');
  const blockAfter = checkCount(retry.blockAfter, 'policy.refusedRetry.blockAfter');
  if (!(reviewAfter <= blockAfter)) {
    throw new TypeError('policy.refusedRetry needs reviewAfter <= blockAfter');
  }
  return Object.freeze({ refusedRetry: Object.freeze({ reviewAfter, blockAfter }) });
}

/**
 * @param {object} state readBypassState output for the window under review
 * @param {object} policy explicit response policy (no defaults)
 * @returns per-fingerprint responses plus the aggregate recommendation
 */
function evaluateBypassResponse(state, policy) {
  const bands = normalizePolicy(policy);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state must be a readBypassState result');
  }
  const prints = state.byFingerprint && typeof state.byFingerprint === 'object' ? state.byFingerprint : {};
  const responses = {};
  let recommendReview = false;
  let recommendStop = false;
  for (const [fingerprint, entry] of Object.entries(prints)) {
    const count = entry && Number.isInteger(entry.count) ? entry.count : 0;
    const kinds = entry && Array.isArray(entry.kinds) ? entry.kinds : [];
    let response = 'none';
    const reasons = [];
    if (kinds.includes('sandbox-escape') || kinds.includes('identity-widening')) {
      response = 'block-and-propose';
      reasons.push('escape or widening signal present in the window');
    } else if (kinds.includes('refused-retry')) {
      if (count >= bands.refusedRetry.blockAfter) {
        response = 'block-and-propose';
        reasons.push(`retried ${count} times, at block threshold ${bands.refusedRetry.blockAfter}`);
      } else if (count >= bands.refusedRetry.reviewAfter) {
        response = 'review';
        reasons.push(`retried ${count} times, at review threshold ${bands.refusedRetry.reviewAfter}`);
      } else {
        reasons.push(`retried ${count} times, below review threshold ${bands.refusedRetry.reviewAfter}`);
      }
    } else {
      reasons.push('unexpected egress keeps its deployment-defined policy');
    }
    if (response === 'review') recommendReview = true;
    if (response === 'block-and-propose') recommendStop = true;
    responses[fingerprint] = Object.freeze({ count, kinds: Object.freeze([...kinds]), response, reasons: Object.freeze(reasons) });
  }
  return Object.freeze({
    version: RESPONSE_VERSION,
    policy: bands,
    recommendReview,
    recommendStop,
    responses: Object.freeze(responses),
  });
}

module.exports = {
  RESPONSE_VERSION,
  normalizePolicy,
  evaluateBypassResponse,
};
