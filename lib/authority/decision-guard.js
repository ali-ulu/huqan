'use strict';

// The runtime's decision guard (#3860, ADR-016; closes the gap #3560 named).
//
// Every operator decision -- `onayla`/`approve`, MCP huqan.approve, the HTTP
// memory-approval route, ingest approvals -- goes through
// handleMcpApprovalDecision, and this guard runs there before anything is
// rejected, claimed or executed. In service mode the decision must be the
// approval authority's own: an Ed25519 envelope from the pinned key, for this
// approval, workspace and tool, for an action hash recomputed here from the
// row's stored arguments, with this verdict, still valid. An operator token, a
// capability, a terminal, an in-process call -- none of them is a substitute,
// because code running as the interactive user can hold all of them.
//
// Legacy mode (no authority installed) passes through unchanged and reports
// that the only boundary is the OS user. An authority that is required or
// installed but unusable refuses every decision.

const { canonicalActionHash } = require('../mcp-operator-capability');
const { canonicalMcpToolName } = require('../mcp-tool-names');
const { isDemoDecisionEnvelope, verifyDecision } = require('./decision-envelope');
const { verifyConsumption } = require('./consumption-envelope');

const DECIDE_HINT = 'decide it with the approval authority (huqan-authority decide <approvalId>), then apply the signed decision';

/**
 * @returns {{ok: true, boundary: string, decision?: object} | {ok: false, code: string, message: string}}
 */
function requireAuthorityDecision({ mode, existing, approvalId, workspaceId, decision, storedArgs, envelope, consumption, now,
  checkConsumption = true }) {
  // #4104: a demo authority signs in-process, with a key the demo process just
  // generated. It exists so `npm run demo:agent-brake` can show a decision
  // without an installed authority; it proves no operator presence, so it must
  // never authorize anything here -- not in service mode, and not in legacy
  // mode where it would otherwise pass through untouched and be reported as if
  // the same user's word were a decision.
  if (isDemoDecisionEnvelope(envelope)) {
    return { ok: false, code: 'DEMO_AUTHORITY_REFUSED',
      message: 'A demo authority decision authorizes nothing: it is minted by the process being demonstrated, not by an authority outside it. Install one and decide there.' };
  }
  if (mode.mode === 'legacy') return { ok: true, boundary: mode.boundary };
  if (mode.mode !== 'service') {
    return { ok: false, code: 'AUTHORITY_UNAVAILABLE',
      message: `The approval authority is required but unusable (${mode.reason}); no decision can be taken.` };
  }
  if (envelope === undefined || envelope === null) {
    return { ok: false, code: 'AUTHORITY_DECISION_REQUIRED',
      message: `This runtime answers to an approval authority; ${DECIDE_HINT}.` };
  }
  const tool = canonicalMcpToolName(existing.tool);
  let actionHash;
  try {
    actionHash = canonicalActionHash({ tool, workspaceId, approvalId, arguments: storedArgs });
  } catch {
    return { ok: false, code: 'AUTHORITY_DECISION_INVALID', message: 'The approval cannot be bound to an action hash.' };
  }
  let verified;
  try {
    verified = verifyDecision(envelope, { publicKey: mode.pin.signingKey,
      expected: { approvalId, workspaceId, tool, actionHash, decision }, now });
  } catch {
    verified = { ok: false, code: 'malformed' };
  }
  if (!verified.ok) {
    return { ok: false, code: 'AUTHORITY_DECISION_INVALID',
      message: `The approval authority's decision does not authorize this action (${verified.code}).` };
  }
  // An approval runs only once the authority has recorded it as consumed, so
  // every execution has an `approval.consumed` entry an audit can match.
  if (decision === 'approved' && checkConsumption) {
    let consumed;
    try {
      consumed = verifyConsumption(consumption, { publicKey: mode.pin.signingKey,
        expected: { approvalId, workspaceId, tool, actionHash } });
    } catch {
      consumed = { ok: false, code: 'malformed' };
    }
    if (!consumed.ok) {
      return { ok: false, code: 'AUTHORITY_CONSUMPTION_REQUIRED',
        message: `The approval authority has not recorded this approval as consumed (${consumed.code}); run huqan-authority apply.` };
    }
  }
  return { ok: true, boundary: mode.boundary, decision: verified.payload };
}

module.exports = { requireAuthorityDecision };
