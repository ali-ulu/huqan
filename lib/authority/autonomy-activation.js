'use strict';

// Verifies the gate hook's `--autonomy-activation <approvalId>` against the
// approval authority (#3892, ADR-016 "Operational approvals").
//
// The activation is an operational approval for `huqan.autonomy_activation`:
// registered with `huqan-authority request`, decided in the operator window
// and consumed by `huqan-authority apply`. The hook runs once per tool call
// and long after that, so it reads the decision back each time and checks
// it at the moment it was consumed -- the authority refuses to consume an
// expired decision, so validity then is what counts. The arguments come from
// the authority's own signed answer; the guard recomputes their action hash.
// A withdrawn, unconsumed, expired, foreign-tool or foreign-workspace approval
// refuses.

const { createAuthorityClient } = require('./authority-client');
const { OPERATIONAL_TOOLS, requireOperationalDecision } = require('./operational-guard');

function refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * @returns {Promise<{ok: true, actor: string, approvedAt: string} | {ok: false, code: string, message: string}>}
 */
async function verifyAutonomyActivation({ mode, approvalId, workspaceId, createClient = createAuthorityClient, now = Date.now }) {
  const client = createClient({ pin: mode.pin });
  const shown = await client.show(approvalId);
  if (shown.status !== 200 || !shown.body || !shown.body.approval) {
    return refuse('AUTHORITY_DECISION_REQUIRED', `the approval authority does not know ${approvalId} (${shown.body?.code || shown.status})`);
  }
  const approval = shown.body.approval;
  if (approval.tool !== OPERATIONAL_TOOLS.AUTONOMY_ACTIVATION) {
    return refuse('AUTHORITY_DECISION_INVALID', `${approvalId} is not an autonomy activation (${approval.tool})`);
  }
  // An activation lasts as long as the registration the operator decided: the
  // expiry they saw, at most the authority's 30-day cap. Then it is requested again.
  if (!(Date.parse(approval.expiresAt) > now())) {
    return refuse('AUTHORITY_DECISION_EXPIRED', `${approvalId} expired at ${approval.expiresAt}; request a new activation`);
  }
  const fetched = await client.getDecision(approvalId);
  if (fetched.status !== 200 || !fetched.body || !fetched.body.envelope) {
    return refuse('AUTHORITY_DECISION_REQUIRED', `${approvalId} has not been decided in the HUQAN Authority window`);
  }
  if (fetched.body.withdrawal) return refuse('AUTHORITY_DECISION_INVALID', `${approvalId} was withdrawn by the operator`);
  const consumedAt = Date.parse(fetched.body.consumption?.payload?.consumedAt);
  if (!Number.isFinite(consumedAt)) {
    return refuse('AUTHORITY_CONSUMPTION_REQUIRED', `${approvalId} is decided but not applied; run huqan-authority apply ${approvalId}`);
  }
  const decided = requireOperationalDecision({
    mode, tool: OPERATIONAL_TOOLS.AUTONOMY_ACTIVATION, workspaceId, args: approval.arguments,
    authority: { approvalId, envelope: fetched.body.envelope, consumption: fetched.body.consumption }, now: consumedAt,
  });
  if (!decided.ok) return refuse(decided.code, decided.message);
  const { operator, decidedAt } = fetched.body.envelope.payload;
  return { ok: true, actor: operator, approvedAt: decidedAt };
}

module.exports = { verifyAutonomyActivation };
