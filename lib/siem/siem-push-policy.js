'use strict';

/**
 * May the SIEM export push to this host? (#4093, PR-B4, INV-B6)
 *
 * Judged by the gates the guard already runs on an agent's egress -- not by a
 * second policy of its own -- and judged inside each push sink's factory, so a
 * push sink that skipped this check cannot be built:
 *
 * - AB12 data residency (lib/data-residency-gate.js), with the residency the
 *   deployment declared in its command policy file. The events describe
 *   actions on citizen data and their findings name the PII types involved, so
 *   the stream is treated as protected data: when a residency is declared, the
 *   SIEM host must be inside it. With none declared the gate stays inert, as it
 *   does for the guard. A policy file the operator named explicitly and that
 *   cannot be read is a refusal, not "no residency": a typo must not turn the
 *   boundary off.
 * - AB13 expected egress (lib/unexpected-egress-gate.js), configured the way
 *   the guard is configured. `block` refuses. `review` refuses too, because in
 *   the guard it means "a human decides" and an unattended export has no human
 *   to ask; the operator who has looked at the host and accepts it says so with
 *   `allowReview` (`--allow-unreviewed-host`), and the run still reports it.
 */

const fs = require('node:fs');
const { readDataResidency } = require('../external-action-command-policy');
const { DATA_RESIDENCY_DECISIONS, evaluateDataResidency } = require('../data-residency-gate');
const {
  UNEXPECTED_EGRESS_DECISIONS,
  evaluateUnexpectedEgress,
  expectedEgressOptions,
} = require('../unexpected-egress-gate');

const SIEM_PUSH_ERRORS = Object.freeze({
  BLOCKED: 'SIEM_PUSH_DESTINATION_BLOCKED',
});

function blocked(message) {
  const error = new Error(message);
  error.code = SIEM_PUSH_ERRORS.BLOCKED;
  return error;
}

function declaredResidency(dataResidency, policyPath) {
  if (dataResidency !== undefined) return dataResidency;
  if (policyPath && !fs.existsSync(policyPath)) {
    throw blocked(`the policy file named for the SIEM push does not exist: ${policyPath}`);
  }
  return readDataResidency(policyPath || undefined);
}

/**
 * @param {object} input
 * @param {string} input.host the push endpoint's host (an IPv6 literal with or without brackets)
 * @param {object|null} [input.dataResidency] overrides the policy file when given
 * @param {string} [input.policyPath] a policy file named explicitly; it must exist
 * @param {object} [input.expectedEgress] overrides the environment when given
 * @param {boolean} [input.allowReview] accept a host AB13 would send to review
 * @param {object} [input.environment]
 * @returns {{allowed: true, host: string, residency: object, expectedEgress: object|null, warnings: string[]}}
 */
function assertPushDestinationAllowed({
  host, dataResidency, policyPath, expectedEgress, allowReview = false, environment = process.env,
} = {}) {
  const target = typeof host === 'string' ? host.trim().toLowerCase().replace(/^\[|\]$/g, '') : '';
  if (!target) throw blocked('a push destination needs a host to be judged');

  const residency = evaluateDataResidency({
    payload: { url: `https://${target.includes(':') ? `[${target}]` : target}/` },
    piiDetected: true,
    residency: declaredResidency(dataResidency, policyPath),
  });
  if (residency.decision === DATA_RESIDENCY_DECISIONS.BLOCK) {
    throw blocked(`SIEM push to ${target} refused by data residency: ${residency.reason}`);
  }

  const warnings = [];
  let expected = null;
  const egressPolicy = expectedEgressOptions({ expectedEgress, environment });
  if (egressPolicy) {
    expected = evaluateUnexpectedEgress({
      destinations: [target],
      expected: egressPolicy.expected,
      decision: egressPolicy.decision,
    });
    if (expected.decision === UNEXPECTED_EGRESS_DECISIONS.BLOCK) {
      throw blocked(`SIEM push to ${target} refused by expected egress: ${expected.reason}`);
    }
    if (expected.decision === UNEXPECTED_EGRESS_DECISIONS.REVIEW) {
      if (!allowReview) {
        throw blocked(`SIEM push to ${target} needs review (${expected.reason}): declare it in HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS, or accept it with --allow-unreviewed-host`);
      }
      warnings.push(`SIEM host ${target} is not a declared egress destination (${expected.reason}); accepted with --allow-unreviewed-host`);
    }
  }

  return Object.freeze({
    allowed: true,
    host: target,
    residency: { decision: residency.decision, reason: residency.reason },
    expectedEgress: expected ? { decision: expected.decision, reason: expected.reason } : null,
    warnings,
  });
}

module.exports = {
  SIEM_PUSH_ERRORS,
  assertPushDestinationAllowed,
};
