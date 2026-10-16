'use strict';

/**
 * The emergency stop, read by the HTTP read/query surfaces (#3905).
 *
 * `lib/mcp/tool-dispatch.js` consults the ledger on every tool call and answers
 * `EMERGENCY_STOPPED`; the HTTP workflow endpoints did not, so a stopped
 * workspace kept answering `ask`, `verify`, `search` and `learn` with 200 while
 * the same workspace was refused over MCP. One decision, two answers.
 *
 * This module is the one place that reads the ledger for HTTP, so the surfaces
 * cannot drift from each other or from the MCP check. The ledger is resolved
 * the same way everywhere else resolves it: an injected ledger when a caller
 * supplies one (tests), otherwise one over `HUQAN_EMERGENCY_STOP_DIR` or the
 * state root. Never from a request field.
 */

const { emergencyStopLedger } = require('../emergency-stop');
const { workflowEnvelope } = require('./workflow-envelope');

const EMERGENCY_STOPPED_CODE = 'EMERGENCY_STOPPED';
const EMERGENCY_STOPPED_MESSAGE = 'This workspace is under an emergency stop.';
// 423 Locked: the workspace exists and is reachable, but the operator has
// stopped it. `lib/authority/authority-service.js` already answers 423 for the
// same "deliberately locked" reason, so this is not a new status for a caller
// to learn.
const EMERGENCY_STOPPED_STATUS = 423;

/**
 * The refusal for a stopped workspace, or null when it may proceed.
 *
 * @param {{ emergencyStop?: object, workspaceId?: string, agentId?: string }} options
 * @returns {null | { statusCode: number, code: string, message: string, scope: string|null, reason: string|null }}
 */
function emergencyStopRefusal({ emergencyStop, workspaceId, agentId } = {}) {
  const ledger = emergencyStopLedger({ emergencyStop });
  const stop = ledger.check({
    workspaceId: workspaceId || 'default',
    ...(agentId ? { agentId } : {}),
  });
  if (!stop || stop.stopped !== true) return null;
  return Object.freeze({
    statusCode: EMERGENCY_STOPPED_STATUS,
    code: EMERGENCY_STOPPED_CODE,
    message: EMERGENCY_STOPPED_MESSAGE,
    scope: stop.scope || null,
    reason: stop.reason || null,
  });
}

/** The workflow envelope a read surface answers a stop with. */
function emergencyStopWorkflowBody(refusal) {
  return workflowEnvelope({
    ok: false,
    status: 'blocked',
    data: null,
    error: { code: refusal.code, message: refusal.message },
  });
}

module.exports = {
  EMERGENCY_STOPPED_CODE,
  EMERGENCY_STOPPED_MESSAGE,
  EMERGENCY_STOPPED_STATUS,
  emergencyStopRefusal,
  emergencyStopWorkflowBody,
};
