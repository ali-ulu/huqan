'use strict';

const path = require('path');
const { readReceiptById } = require('../receipt/receipt-read-index');
const { createReadWorkflowHttpRouter } = require('./read-workflow-actions');
const { createWorkflowDataRoutes, createLearnApprovalDecision } = require('./workflow-data-routes');
const { createPrGuardianOptions } = require('./pr-guardian-config');
const { readTrustedBatchKeys } = require('../external-action-receipt-collector');
const { readCollectorSealKey } = require('../collector-seal-config');
const {
  JSON_CONTENT_TYPE,
  buildCorsHeaders,
  writeJson,
  writeApiError,
} = require('../server-response-helpers');
const { createIngestApprovalRuntime } = require('./ingest-approval-runtime');
const { createIngestHttpRoutes } = require('./ingest-http-routes');
const { createObservabilityServerRuntime } = require('../observability/server-runtime');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { createDurableCapabilityNonceStore } = require('../mcp-capability-nonce-store');
const { workflowDecisionNonceDirectory } = require('./workflow-decision-gate');

function createIngestWorkflowRuntime({
  kernel,
  readEnvironment,
  parseJsonRequest,
  denyIfUnauthorized,
  createOptionalRouteBoundaries,
  createAgent,
  callMcpTool,
  resolveExperienceJournal,
  emergencyStop,
}) {
  let companyRuntimeReady = false;
  const ensureCompanyRuntime = () => {
    if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
      kernel.enableCapability('companyMode');
    }
    if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
      kernel.enableCapability('pluginCapabilities');
    }
    if (!companyRuntimeReady && kernel.plugins && typeof kernel.plugins.load === 'function') {
      kernel.plugins.load(path.join(__dirname, '..', '..', 'plugins'));
      companyRuntimeReady = true;
    }
  };

  const ingestApprovalRuntime = createIngestApprovalRuntime({
    kernel,
    readEnvironment,
    ensureRuntime: ensureCompanyRuntime,
  });
  const getApprovalStore = () => ingestApprovalRuntime.getStore();

  const optionalRoutes = createOptionalRouteBoundaries({
    emergencyStop: { emergencyStop },
    memoryApproval: {
      kernel,
      getParseJsonRequest: () => parseJsonRequest,
      getWriteJson: () => writeJson,
      approvalRuntime: () => ({ approvalStore: getApprovalStore() }),
    },
    prGuardian: createPrGuardianOptions({
      getApprovalStore,
      getParseJsonRequest: () => parseJsonRequest,
      getWriteJson: () => writeJson,
    }),
    receiptCollector: {
      collectorRoot: readEnvironment('RECEIPT_COLLECTOR_ROOT'),
      getParseJsonRequest: () => parseJsonRequest,
      trustedKeys: readTrustedBatchKeys(readEnvironment('RECEIPT_TRUSTED_KEYS')),
      requireSignature: readEnvironment('RECEIPT_REQUIRE_SIGNATURE') === '1',
      sealKey: readCollectorSealKey(),
    },
  });

  const observabilityRuntime = createObservabilityServerRuntime({
    kernel,
    getStorage: getApprovalStore,
    createAgent,
    parseJsonRequest,
    writeJson,
    denyIfUnauthorized,
    readEnvironment,
  });

  // #3926: learn decisions on this router need operator authority, not just
  // the transport key. The nonce store defaults to the memory-approval
  // boundary's directory, so a capability spent on one surface cannot replay
  // on the other.
  const workflowDecisionNonces = createDurableCapabilityNonceStore({
    directory: workflowDecisionNonceDirectory(kernel),
  });
  const handleWorkflowDataRoute = createWorkflowDataRoutes({
    getApprovalStore,
    decideApproval: args => ingestApprovalRuntime.decide(args),
    readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters),
    parseJsonRequest,
    writeJson,
    proposeLearn: args => callMcpTool(
      kernel,
      { name: 'huqan.learn', arguments: args },
      { approvalStore: getApprovalStore() },
    ),
    submitIngest: data => ingestApprovalRuntime.submit(data),
    createAgent: options => observabilityRuntime.createAgent(options),
    decideLearnApproval: createLearnApprovalDecision({ kernel, getApprovalStore }),
    emergencyStop,
    operatorToken: readCompatibleEnvironmentVariable('MCP_OPERATOR_TOKEN') || '',
    operatorCapabilityNonces: workflowDecisionNonces,
  });

  const handleReadWorkflow = createReadWorkflowHttpRouter({
    kernel,
    parseJsonRequest,
    writeJson,
    writeApiError,
    ensureCapabilities: ensureCompanyRuntime,
    emergencyStop,
    getExperienceJournal: () => {
      if (kernel.experienceJournal) return kernel.experienceJournal;
      if (typeof resolveExperienceJournal !== 'function') return null;
      return resolveExperienceJournal({ kernel }, ingestApprovalRuntime.getStore());
    },
  });

  const handleIngestHttpRoutes = createIngestHttpRoutes({
    kernel,
    approvalRuntime: ingestApprovalRuntime,
    ensureCompanyRuntime,
    parseJsonRequest,
    denyIfUnauthorized,
    writeJson,
    writeApiError,
    buildCorsHeaders,
    JSON_CONTENT_TYPE,
  });

  return Object.freeze({
    optionalRoutes,
    ingestApprovalRuntime,
    configureHttpHumanOversight: config => ingestApprovalRuntime.configureHumanOversight(config),
    configureHttpAgentIdentity: config => ingestApprovalRuntime.configureAgentIdentity(config),
    handleWorkflowDataRoute,
    handleReadWorkflow,
    handleObservabilityRoute: observabilityRuntime.handleRoute,
    observabilityRuntime,
    handleIngestHttpRoutes,
  });
}

module.exports = { createIngestWorkflowRuntime };
