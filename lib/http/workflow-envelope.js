'use strict';

const crypto = require('crypto');
const { WORKFLOW_STATUSES } = require('../workflow-contract');

function workflowEnvelope({ ok, status, data = null, error = null, evidence = [], confidence = null, traceId, receiptId = null }) {
  const normalizedStatus = WORKFLOW_STATUSES.includes(status) ? status : (ok ? 'completed' : 'failed');
  return {
    ok: Boolean(ok),
    status: normalizedStatus,
    data,
    error,
    evidence: Array.isArray(evidence) ? evidence : [],
    confidence: Number.isFinite(confidence) ? confidence : null,
    traceId: traceId || crypto.randomUUID(),
    receiptId: receiptId || null,
  };
}

function unavailableWorkflowEnvelope(traceId) {
  return workflowEnvelope({
    ok: false,
    status: 'capability_not_available',
    error: {
      code: 'UNSUPPORTED_WORKFLOW',
      message: 'This workflow is not enabled on the HTTP compatibility surface.',
    },
    traceId,
  });
}

module.exports = { workflowEnvelope, unavailableWorkflowEnvelope };
