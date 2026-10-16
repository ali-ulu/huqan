'use strict';

const { buildActionFingerprint, buildFailureFingerprint } = require('./fingerprint');
const { makeId } = require('./decision');
const { copyDeterministicJson } = require('../deterministic-json-copy');

/**
 * A record may carry a bounded, deterministic payload when the transform it
 * declares needs more than the observed/expected pair -- `create_file` needs
 * the content a file that does not exist yet should hold. A payload that is not
 * JSON-safe is refused (returns null) rather than coerced, so a record either
 * carries a payload the coder can use verbatim or carries none. Absence is
 * expressed as `null`, which the producer reads as "no payload".
 */
function normalizePayload(value) {
  if (value === undefined || value === null) return null;
  try {
    return copyDeterministicJson(value);
  } catch {
    return null;
  }
}

function buildFailureRecord({ input, action, observed, evidence, trust, verification }) {
  const failureFingerprint = buildFailureFingerprint(input);
  const payload = normalizePayload(input.payload);
  return {
    kind: 'failure_record', schemaVersion: '1.0.0',
    failureId: makeId('failure', { failureFingerprint }),
    source: trust.source, verificationStatus: trust.verificationStatus, trust: trust.trust,
    verificationReason: verification.reason,
    action: { ...action, actionFingerprint: buildActionFingerprint(input) },
    expected: typeof input.expected === 'string' ? input.expected.trim() : '', observed, payload,
    evidence, failureFingerprint,
    workspaceId: action.workspaceId, recordedAt: new Date().toISOString(),
  };
}

module.exports = { buildFailureRecord };
