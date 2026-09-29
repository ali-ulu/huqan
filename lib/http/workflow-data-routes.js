'use strict';

const { createWorkflowDataRouteHandler } = require('./workflow-data-route-groups');
const { createLearnApprovalDecision, statusForLearnDecisionError } = require('./workflow-data-approval-helpers');

function createWorkflowDataRoutes({
  getApprovalStore,
  decideApproval,
  decideLearnApproval,
  readReceipt,
  parseJsonRequest,
  writeJson,
  proposeLearn,
  submitIngest,
  createAgent,
}) {
  if (![getApprovalStore, decideApproval, readReceipt, parseJsonRequest, writeJson, proposeLearn, submitIngest, createAgent].every(fn => typeof fn === 'function')) {
    throw new TypeError('workflow data route dependencies are required');
  }
  // Optional so existing callers (and their fixtures) keep working: when it
  // is absent, learn rows stay listable/readable but their decision fails
  // closed instead of running through the ingest executor.
  const decideLearn = typeof decideLearnApproval === 'function' ? decideLearnApproval : null;

  return createWorkflowDataRouteHandler({
    getApprovalStore,
    decideApproval,
    decideLearn,
    readReceipt,
    parseJsonRequest,
    writeJson,
    proposeLearn,
    submitIngest,
    createAgent,
  });
}

module.exports = { createWorkflowDataRoutes, createLearnApprovalDecision, statusForLearnDecisionError };
