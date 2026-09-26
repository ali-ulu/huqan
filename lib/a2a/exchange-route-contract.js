'use strict';

// Constants the A2A exchange route and its parts share, moved out of
// exchange-route.js (#2185) so the parts do not require the route itself.

const MAX_BODY_BYTES = 1024 * 1024;
const CANONICAL_WORKSPACE = 'default';
const A2A_EXCHANGE_PATH = '/api/a2a/exchange';

/**
 * Reason codes this module adds on top of the evaluator's own vocabulary.
 *
 * They describe transport-level refusals only. Every trust decision keeps the
 * evaluator's reason, unmodified, so a rejected exchange reads the same here as
 * it does in the conformance report.
 */
const A2A_ROUTE_ERRORS = Object.freeze({
  METHOD: 'a2a_method_not_allowed',
  BODY: 'a2a_request_body_invalid',
  WORKSPACE: 'a2a_workspace_not_canonical',
  UNAVAILABLE: 'a2a_exchange_unavailable',
});

const A2A_FIREWALL_POLICY_MISSING = 'A2A_DELEGATED_POLICY_MISSING';

module.exports = Object.freeze({
  A2A_EXCHANGE_PATH,
  A2A_FIREWALL_POLICY_MISSING,
  A2A_ROUTE_ERRORS,
  CANONICAL_WORKSPACE,
  MAX_BODY_BYTES,
});
