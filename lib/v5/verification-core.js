'use strict';

// Facade for the split verification modules (#2257). This is the public
// contract: lib/http/v5-package-import-route.js and the v5 adapter/resolver
// tests require this path. The bounded structural verifier remains a
// structural verifier with no cryptographic, network, or clock dependency
// (see verification-evaluator.js and the #1299 test notes).
const {
  SUPPORTED_ALGORITHM,
  SUPPORTED_SCHEMA_VERSION,
  evaluateBoundedVerification
} = require('./verification-evaluator');
const {
  normalizeCryptographicVerificationEvidence
} = require('./verification-evidence-normalizer');

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_ALGORITHM,
  normalizeCryptographicVerificationEvidence,
  evaluateBoundedVerification
};
