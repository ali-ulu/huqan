'use strict';

const crypto = require('node:crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function toObservationEvent({ agentId, runId, stepId, toolName, kind, observedState, decision = 'unknown', receiptId = null } = {}) {
  if (!agentId || !runId || !stepId || !toolName) {
    throw new Error('agentId, runId, stepId and toolName are required');
  }
  return Object.freeze({
    schemaVersion: 'huqan.external-event.v1',
    agent_id: String(agentId),
    run_id: String(runId),
    step_id: String(stepId),
    action: 'tool.requested',
    target: `${kind || 'tool'}:${toolName}`,
    input_hash: sha256Hex(`${agentId}:${runId}:${stepId}:${toolName}`),
    observed_state: String(observedState || 'mcp tool call proposed, awaiting gate decision'),
    decision,
    receipt_id: receiptId,
  });
}

module.exports = { toObservationEvent, sha256Hex };
