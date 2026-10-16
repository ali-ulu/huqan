'use strict';

// Doctor finding for AB13, the unexpected-egress gate (#3006).
//
// AB13 is the one gate in the external-action chain that is inert until a
// deployment declares its expected destinations: with nothing configured
// `expectedEgressOptions` returns null, the gate never runs, and outbound
// traffic to an undeclared host passes with no verdict and no warning. That is
// a deliberate choice (an invented allowlist would either block every
// integration or mean nothing), but it left "no egress gate" a silent state in
// a stack that is otherwise fail-closed.
//
// This reports the resolved state so an operator can see whether the gate is
// on. It never returns a failure: unconfigured is the documented default, not a
// misconfiguration, and doctor exits non-zero on any failed check.

const { expectedEgressOptions } = require('./unexpected-egress-gate');

const UNCONFIGURED_MESSAGE =
  'not configured; AB13 is inert and unexpected egress is unobserved (fail-open default, see README Limits)';

/**
 * @param {object} opts
 * @param {object} [opts.environment] defaults to process.env
 * @returns {{ok: boolean, detail: string, configured: boolean, decision: string|null,
 *            expectedDestinations: number}}
 */
function checkUnexpectedEgress(opts = {}) {
  const resolved = expectedEgressOptions({ environment: opts.environment || process.env });
  if (!resolved) {
    return {
      ok: true,
      detail: UNCONFIGURED_MESSAGE,
      configured: false,
      decision: null,
      expectedDestinations: 0,
    };
  }
  const count = resolved.expected.length;
  return {
    ok: true,
    detail: `configured; decision ${resolved.decision}; ${count} expected destination${count === 1 ? '' : 's'}`,
    configured: true,
    decision: resolved.decision,
    expectedDestinations: count,
  };
}

module.exports = {
  UNCONFIGURED_MESSAGE,
  checkUnexpectedEgress,
};
