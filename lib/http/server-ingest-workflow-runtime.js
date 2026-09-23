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

function createIngestWorkflowRuntime({
  kernel,
  readEnvironment,
  parseJsonRequest,
  denyIfUnauthorized,
  createOptionalRouteBoundaries,
  createAgent,
  callMcpTool,
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
  });

  const handleReadWorkflow = createReadWorkflowHttpRouter({
    kernel,
    parseJsonRequest,
    writeJson,
    writeApiError,
    ensureCapabilities: ensureCompanyRuntime,
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
