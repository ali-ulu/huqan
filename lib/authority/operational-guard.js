'use strict';

// The approval authority's guard for operator surfaces without an approval
// row (#3860 P6b, #3892, ADR-016 "Operational approvals").
//
// `huqan.agent_resume`, lifting an emergency stop, `terfi` and the gate hook's
// autonomy activation are operator decisions, but none of them is a row in the
// runtime's approval store. They are registered with the authority as
// operational approvals (`huqan-authority request`), decided in the operator
// window and carried out by `huqan-authority apply`, which hands the signed
// decision and consumption envelopes to the surface in-process -- the same
// path P4 uses for rows. The surface verifies them here against the arguments
// it is about to act on, with the P4 decision guard, so there is one canonical
// action hash and one verifier.
//
// Legacy mode (no authority installed) passes through. Service mode without a
// verified, consumed decision refuses, and so does anything that throws while
// verifying: a guard that cannot answer never lets the action through.

const { canonicalMcpToolName } = require('../mcp-tool-names');
const { requireAuthorityDecision } = require('./decision-guard');

const OPERATIONAL_TOOLS = Object.freeze({
  AGENT_RESUME: 'huqan.agent_resume',
  EMERGENCY_STOP: 'huqan.emergency_stop',
  PROMOTE: 'terfi',
  AUTONOMY_ACTIVATION: 'huqan.autonomy_activation',
});

const OPERATIONAL_TOOL_SET = new Set(Object.values(OPERATIONAL_TOOLS));

function isOperationalTool(tool) {
  return OPERATIONAL_TOOL_SET.has(canonicalMcpToolName(tool));
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The exact command that registers this operation with the authority. */
function operationalRequestCommand({ tool, workspaceId, args }) {
  return `huqan-authority request ${canonicalMcpToolName(tool)} --workspace ${shellSingleQuote(workspaceId)}`
    + ` --args ${shellSingleQuote(JSON.stringify(args))}`;
}

function refusal(code, message, binding) {
  let request = null;
  try {
    request = operationalRequestCommand(binding);
  } catch {
    // Arguments that cannot be printed cannot be registered either; the refusal stands.
  }
  return { ok: false, code, message, request };
}

/**
 * @param {object} input
 * @param {{mode: string, boundary?: string, reason?: string, pin?: object}} input.mode
 * @param {string} input.tool
 * @param {string} input.workspaceId
 * @param {object} input.args the arguments the surface is about to act on
 * @param {{approvalId?: string, envelope?: object, consumption?: object}} [input.authority]
 * @returns {{ok: true, boundary: string, approvalId?: string}
 *   | {ok: false, code: string, message: string, request: string}}
 */
function requireOperationalDecision({ mode, tool, workspaceId, args, authority = {}, now = Date.now() }) {
  const binding = { tool, workspaceId, args };
  try {
    if (mode.mode === 'legacy') return { ok: true, boundary: mode.boundary };
    const approvalId = authority && authority.approvalId;
    if (mode.mode === 'service' && (typeof approvalId !== 'string' || !approvalId)) {
      return refusal('AUTHORITY_DECISION_REQUIRED',
        'This runtime answers to an approval authority; register the operation, decide it in the HUQAN Authority window,'
        + ' then run huqan-authority apply <approvalId>.', binding);
    }
    const guard = requireAuthorityDecision({
      mode, existing: { tool }, approvalId, workspaceId, decision: 'approved', storedArgs: args,
      envelope: authority.envelope, consumption: authority.consumption, now,
    });
    if (!guard.ok) return refusal(guard.code, guard.message, binding);
    return { ok: true, boundary: guard.boundary, approvalId };
  } catch (error) {
    return refusal('AUTHORITY_DECISION_INVALID',
      `The approval authority's decision could not be verified (${error && error.message ? error.message : 'unknown'}).`,
      binding);
  }
}

module.exports = { OPERATIONAL_TOOLS, isOperationalTool, operationalRequestCommand, requireOperationalDecision };
