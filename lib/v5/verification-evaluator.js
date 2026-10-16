'use strict';

const { isPlainObject } = require('../is-plain-object');

const SUPPORTED_ALGORITHM = 'test-structural-v1';

const {
  SUPPORTED_SCHEMA_VERSION,
  isNonEmptyString,
  malformedInput
} = require('./verification-input-shape');
const {
  forbiddenClaimReason,
  keyStateReason,
  signatureReason
} = require('./verification-reason-mapping');

function result(verificationStatus, reasonCategory) {
  return { verificationStatus, reasonCategory };
}

function notVerified(reasonCategory) {
  return result('not_verified', reasonCategory);
}

function evaluateBoundedVerification(input) {
  if (!isPlainObject(input) || !isNonEmptyString(input.signature)) {
    return notVerified('missing_signature_evidence');
  }
  if (malformedInput(input)) {
    return notVerified('malformed_signature_evidence');
  }

  const claimReason = forbiddenClaimReason(input.claims);
  if (claimReason) {
    return notVerified(claimReason);
  }
  if (input.algorithm !== SUPPORTED_ALGORITHM) {
    return notVerified('unsupported_algorithm');
  }
  if (
    input.payload.signedPayloadId !== undefined &&
    input.payload.signedPayloadId !== input.payload.payloadId
  ) {
    return notVerified('payload_identity_mismatch');
  }
  if (
    input.payload.expectedPayloadDigest !== undefined &&
    input.payload.expectedPayloadDigest !== input.payload.payloadDigest
  ) {
    return notVerified('payload_digest_mismatch');
  }

  const stateReason = keyStateReason(input);
  if (stateReason) {
    return notVerified(stateReason);
  }
  // Every structural check above passed. This bounded verifier still cannot
  // attest the signature cryptographically, so it fails closed here rather
  // than claiming 'verified' -- see signatureReason's contract above.
  return notVerified(signatureReason(input.signature));
}

module.exports = {
  SUPPORTED_ALGORITHM,
  SUPPORTED_SCHEMA_VERSION,
  evaluateBoundedVerification
};
