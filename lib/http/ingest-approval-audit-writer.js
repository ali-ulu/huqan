'use strict';

const { createIngestApprovalAuditWriter } = require('../workbench/ingest-approval-audit-writer');
const {
  buildHttpIdentityAdmissionContext,
  createHttpIdentityMutationAdmission,
} = require('./identity-mutation-admission');

function createHttpIngestApprovalAuditWriter({ graph, getIdentityConfig, hashResult, ledger = null } = {}) {
  if (typeof getIdentityConfig !== 'function') throw new TypeError('HTTP identity config resolver is required');
  return createIngestApprovalAuditWriter({
    graph,
    admission: createHttpIdentityMutationAdmission({ getConfig: getIdentityConfig }),
    identityContext: buildHttpIdentityAdmissionContext,
    hashResult,
    ledger,
  });
}

module.exports = { createHttpIngestApprovalAuditWriter };
