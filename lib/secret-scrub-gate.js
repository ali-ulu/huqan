'use strict';

/**
 * AB7 — Secret Scrub Gate.
 *
 * tool-call-gate (AB2) already detects secret-looking values in tool-call
 * args (SECRET_ARGS_REVIEW_REQUIRED) but does not redact them. This module
 * reuses that same detection (hasSecretLookingValue / redactSecretValues,
 * both exported from lib/tool-call-gate.js) to scrub secret-looking values
 * out of any payload before it is persisted (approval store, dry-run
 * result, audit findings) or logged, so a detected secret never survives in
 * plain text past the point of detection.
 */

const {
  SECRET_KEY_PATTERNS,
  hasSecretLookingValue,
  redactSecretValues,
} = require('./tool-call-gate');

const AB7_GATE_VERSION = 'AB7-v0.1.0';

/**
 * Scrubs secret-looking values out of `payload` and reports whether
 * anything was redacted, so callers can record that AB7 scrubbing applied
 * (e.g. in gate metadata) without needing to diff the payload themselves.
 */
function scrubSecrets(payload) {
  const secretDetected = hasSecretLookingValue(payload);
  return {
    scrubbed: secretDetected ? redactSecretValues(payload) : payload,
    secretDetected,
    gateVersion: AB7_GATE_VERSION,
  };
}

module.exports = {
  AB7_GATE_VERSION,
  SECRET_KEY_PATTERNS,
  scrubSecrets,
};
