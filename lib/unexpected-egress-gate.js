'use strict';

/**
 * AB13 — unexpected external egress.
 *
 * The guard chain already runs seven gates, and after #1891 was measured none
 * of them asked the plainest question a reviewer would ask about an outbound
 * action: *is this destination one we expected to talk to at all?*
 *
 * - AB9 reports what the payload IS (PII, secrets). It says nothing about where.
 * - AB12 combines the two, but only speaks when citizen data is present AND a
 *   residency is declared. An unexpected destination carrying nothing sensitive
 *   passed in silence.
 * - `lib/connector-action-firewall.js` assigns an egress class per connector,
 *   and says so in its own comment: no cross-call chain detector, an explicit
 *   non-claim until a policy owner is wired to it.
 * - `lib/ssrf-guard.js` blocks private-address targets. That is a different
 *   question -- it stops you reaching inside, not leaving unexpectedly.
 *
 * So an action could send perfectly ordinary data to a host nobody had ever
 * declared, through any connector, and no gate had an opinion. This is that
 * gate, and it is deliberately independent of payload classification: whether
 * the bytes are sensitive is AB9's question, and a destination being unexpected
 * is wrong on its own.
 *
 * ## Reuses, does not re-detect
 *
 * Destinations come from AB9's finding, which already records them on every
 * action (`collectDestinations`). Host matching is AB12's `withinResidency`, so
 * "is api.github.com covered by github.com" has exactly one answer in this
 * codebase rather than two that can drift apart.
 *
 * ## Inert unless declared
 *
 * With nothing configured the gate does not run at all. An allowlist of
 * expected destinations is a statement about a deployment's architecture, and
 * inventing a default would either block every real integration or allow
 * everything and mean nothing.
 *
 * Enabling with an empty list is NOT the same as leaving it unconfigured: an
 * empty allowlist is the coherent policy "nothing should be leaving", and the
 * gate stays on.
 *
 * ## Review, not block, by default
 *
 * A newly added integration looks exactly like exfiltration to an allowlist.
 * The honest first verdict is "somebody should look", and a deployment that
 * has finished declaring its destinations sets `block`.
 *
 * ## Only ever tightens
 *
 * Returns allow / review / block, and the guard merges with `mergeDecision`,
 * which takes the strictest. Nothing here can relax another gate's verdict.
 */

const { withinResidency, LOCAL_HOSTS } = require('./data-residency-gate');

const AB13_GATE_VERSION = 'huqan.unexpected-egress-gate.v1';

const UNEXPECTED_EGRESS_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const UNEXPECTED_EGRESS_REASONS = Object.freeze({
  NO_DESTINATION: 'unexpected_egress_no_destination',
  ALL_EXPECTED: 'unexpected_egress_all_destinations_expected',
  UNEXPECTED: 'unexpected_egress_destination',
  UNREADABLE_DESTINATION: 'unexpected_egress_unreadable_destination',
});

const MAX_REPORTED_DESTINATIONS = 16;

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : '';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(text).filter(Boolean);
  return [];
}

/**
 * Opt-in configuration. Returns null when the deployment has not declared an
 * expected-egress policy, which is the difference between "not configured" and
 * "configured as empty" -- the latter is a real policy and keeps the gate on.
 */
function expectedEgressOptions(options = {}) {
  const supplied = options.expectedEgress;
  const configured = supplied !== null && typeof supplied === 'object';
  if (configured && supplied.enabled === false) return null;

  let decision = null;
  let expected = null;

  if (configured && supplied.enabled === true) {
    decision = supplied.decision === UNEXPECTED_EGRESS_DECISIONS.BLOCK
      ? UNEXPECTED_EGRESS_DECISIONS.BLOCK
      : UNEXPECTED_EGRESS_DECISIONS.REVIEW;
    expected = normalizeList(supplied.destinations);
  } else {
    const environment = options.environment || process.env;
    const flag = text(environment.HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS);
    if (flag === UNEXPECTED_EGRESS_DECISIONS.BLOCK) decision = UNEXPECTED_EGRESS_DECISIONS.BLOCK;
    else if (['1', 'true', 'review', 'enable', 'require'].includes(flag)) {
      decision = UNEXPECTED_EGRESS_DECISIONS.REVIEW;
    }
    if (decision) expected = normalizeList(environment.HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS);
  }

  if (!decision) return null;

  return Object.freeze({
    decision,
    expected: Object.freeze(expected || []),
  });
}

function verdict(decision, reason, unexpectedDestinations = []) {
  return Object.freeze({
    gateVersion: AB13_GATE_VERSION,
    decision,
    reason,
    unexpectedDestinations: Object.freeze(unexpectedDestinations.slice(0, MAX_REPORTED_DESTINATIONS)),
  });
}

/**
 * @param {object} input
 * @param {string[]} input.destinations hosts AB9 observed on this action
 * @param {string[]} input.expected the deployment's declared allowlist
 * @param {string} input.decision the verdict to return when something is unexpected
 * @param {boolean} [input.unparseable] AB9 saw a destination it could not read
 * @returns {{gateVersion: string, decision: string, reason: string,
 *            unexpectedDestinations: string[]}}
 */
function evaluateUnexpectedEgress({ destinations, expected, decision, unparseable = false } = {}) {
  const configuredDecision = decision === UNEXPECTED_EGRESS_DECISIONS.BLOCK
    ? UNEXPECTED_EGRESS_DECISIONS.BLOCK
    : UNEXPECTED_EGRESS_DECISIONS.REVIEW;
  const allowed = normalizeList(expected);
  const hosts = normalizeList(destinations);

  // Loopback is not egress. `withinResidency` already treats it as inside, and
  // this gate must agree with AB12 rather than hold a second opinion.
  const external = hosts.filter((host) => !LOCAL_HOSTS.has(host));
  const unexpected = external.filter((host) => !withinResidency(host, allowed));

  if (unexpected.length > 0) {
    return verdict(configuredDecision, UNEXPECTED_EGRESS_REASONS.UNEXPECTED, unexpected);
  }

  // "I could not read where this was going" is not evidence that it was going
  // somewhere declared. Reported after the explicit-host case so a readable
  // violation always names the host it found.
  if (unparseable) {
    return verdict(configuredDecision, UNEXPECTED_EGRESS_REASONS.UNREADABLE_DESTINATION);
  }

  if (external.length === 0) {
    return verdict(UNEXPECTED_EGRESS_DECISIONS.ALLOW, UNEXPECTED_EGRESS_REASONS.NO_DESTINATION);
  }

  return verdict(UNEXPECTED_EGRESS_DECISIONS.ALLOW, UNEXPECTED_EGRESS_REASONS.ALL_EXPECTED);
}

module.exports = {
  AB13_GATE_VERSION,
  UNEXPECTED_EGRESS_DECISIONS,
  UNEXPECTED_EGRESS_REASONS,
  expectedEgressOptions,
  evaluateUnexpectedEgress,
};
