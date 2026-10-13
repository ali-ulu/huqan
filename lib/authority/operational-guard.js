'use strict';

// The approval authority's guard for operator surfaces that carry no approval
// row (#3860 P6, ADR-016 "the guard does not yet cover these").
//
// `huqan.agent_resume`, `huqan.emergency_stop` issue/lift, `terfi` and the gate
// hook's `--autonomy-activation` are operator decisions, but none of them is
// an entry in the runtime's approval store, so the P4 decision guard -- which
// recomputes the action hash from a stored row -- cannot run on them as is.
// This module gives the same answer for them: in service mode the decision
// must be the approval authority's own Ed25519 envelope for exactly this
// operation, plus the signed consumption envelope once the authority has an
// `approval.consumed` entry. An operator token or a capability is never a
// substitute: code running as the same OS user holds both.
//
// Legacy mode (no authority installed) passes through unchanged and reports
// `boundary: same-user`. An authority that is required or installed but
// unusable refuses every request, like the P4 guard.
//
// The approval id binds the envelopes to one operation. Surfaces that have
// their own id use it; the rest derive one from the canonical arguments, so
// the same action always maps to the same id the operator saw when deciding.

const crypto = require('node:crypto');
// Canonical JSON stringify with sorted object keys, keys on their fixed, deterministic
// paths and the object inserted between lexical neighbors: what we hash is the same
// object ahead of computing digest as the one the operator-approved canonical form.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
const { canonicalActionHash } = require('../mcp-operator-capability');
const { canonicalMcpToolName } = require('../mcp-tool-names');
const { verifyDecision } = require('./decision-envelope');
const { verifyConsumption } = require('./consumption-envelope');

const DECIDE_HINT = 'decide it with the approval authority (huqan-authority decide <approvalId>), then pass the signed decision and consumption envelopes';

/**
 * Derive the deterministic approval id for an operational decision.
 * @param {{tool: string, workspaceId: string, args: object}} binding
 */
function operationalApprovalId({ tool, workspaceId, args }) {
  const digest = crypto.createHash('sha256')
    .update(stableStringify({ kind: 'huqan.authority.operational.v1', tool, workspaceId, arguments: args }), 'utf8')
    .digest('hex');
  return `ops-${digest.slice(0, 16)}`;
}

/**
 * Verify the authority's decision for an operator surface without an approval
 * row. Mirrors lib/authority/decision-guard.js: legacy passes through, the
 * service mode accepts only the pinned authority's own decision (and, for a
 * granted action, its consumption), anything else fails closed.
 *
 * @returns {{ok: true, boundary: string, decision?: object} | {ok: false, code: string, message: string}}
 */
function requireAuthorityOperationalDecision({
  mode,
  tool,
  workspaceId = 'default',
  approvalId,
  args = {},
  envelope,
  consumption,
  now,
}) {
  if (mode.mode === 'legacy') return { ok: true, boundary: mode.boundary };
  if (mode.mode !== 'service') {
    return { ok: false, code: 'AUTHORITY_UNAVAILABLE',
      message: `The approval authority is required but unusable (${mode.reason}); this operator action cannot be taken.` };
  }
  const canonicalTool = canonicalMcpToolName(tool);
  let actionHash;
  try {
    actionHash = canonicalActionHash({ tool: canonicalTool, workspaceId, approvalId, arguments: args });
  } catch {
    return { ok: false, code: 'AUTHORITY_DECISION_INVALID', message: 'This operation cannot be bound to an action hash.' };
  }
  if (envelope === undefined || envelope === null) {
    return { ok: false, code: 'AUTHORITY_DECISION_REQUIRED',
      message: `This runtime answers to an approval authority; ${DECIDE_HINT}.` };
  }
  let verified;
  try {
    verified = verifyDecision(envelope, { publicKey: mode.pin.signingKey,
      expected: { approvalId, workspaceId, tool: canonicalTool, actionHash, decision: 'approved' }, now });
  } catch {
    verified = { ok: false, code: 'malformed' };
  }
  if (!verified.ok) {
    return { ok: false, code: 'AUTHORITY_DECISION_INVALID',
      message: `The approval authority's decision does not authorize this action (${verified.code}).` };
  }
  let consumed;
  try {
    consumed = verifyConsumption(consumption, { publicKey: mode.pin.signingKey,
      expected: { approvalId, workspaceId, tool: canonicalTool, actionHash } });
  } catch {
    consumed = { ok: false, code: 'malformed' };
  }
  if (!consumed.ok) {
    return { ok: false, code: 'AUTHORITY_CONSUMPTION_REQUIRED',
      message: `The approval authority has not recorded this action as consumed (${consumed.code}).` };
  }
  return { ok: true, boundary: mode.boundary, decision: verified.payload };
}

module.exports = { operationalApprovalId, requireAuthorityOperationalDecision };
