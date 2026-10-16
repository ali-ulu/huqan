'use strict';

const crypto = require('node:crypto');

const REVIEW_TARGETS = ['pay', 'submit', 'checkout', 'transfer'];

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function toBrowserEvent({ agentId, runId, stepId, browserAction, page, element, observedState } = {}) {
  if (!agentId || !runId || !stepId || !browserAction || !page) {
    throw new Error('agentId, runId, stepId, browserAction and page are required');
  }
  const target = `page:${page}${element ? `#${element}` : ''}`;
  const decision = REVIEW_TARGETS.some((t) => target.includes(t)) ? 'review' : 'unknown';
  return Object.freeze({
    schemaVersion: 'huqan.external-event.v1',
    agent_id: String(agentId),
    run_id: String(runId),
    step_id: String(stepId),
    action: String(browserAction),
    target,
    input_hash: sha256Hex(`${agentId}:${runId}:${stepId}:${browserAction}:${target}`),
    observed_state: String(observedState || 'browser action proposed, page-level target only'),
    decision,
    receipt_id: null,
  });
}

module.exports = { toBrowserEvent };
