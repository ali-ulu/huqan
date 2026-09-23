'use strict';

const path = require('path');
const { CANONICAL_KERNEL_VERSION } = require('../kernel-factory');
const { CANONICAL_AGENT_VERSION, createAgent } = require('../../agentRuntime');
const { readReceiptById } = require('../receipt/receipt-read-index');
const { createWorkbenchReadHttpRouter } = require('../workbench/workbench-read-http-router');
const { createReadWorkflowHttpRouter } = require('./read-workflow-actions');
const { createWorkflowDataRoutes, createLearnApprovalDecision } = require('./workflow-data-routes');
const { readExactWorkspace } = require('./exact-workspace');
const { createPrGuardianOptions } = require('./pr-guardian-config');
const { createFitnessDashboardRoute } = require('./fitness-dashboard-route');
const { readTrustedBatchKeys } = require('../external-action-receipt-collector');
const { readCollectorSealKey } = require('../collector-seal-config');
const { callTool: callMcpTool } = require('../../mcpServer');
const {
  JSON_CONTENT_TYPE,
  buildCorsHeaders,
  writeJson,
  writeApiError,
  legacyVerify,
} = require('../server-response-helpers');
const {
  readTrustFilters,
  hasTrustQuery,
} = require('../http-trust-query');
const { V2_STATUS_PHASES } = require('./v2-status-phases');
const { createRuntimeStatusHandlers } = require('./runtime-status');
const { createCoreHttpRoutes } = require('./core-http-routes');
const { createIngestApprovalRuntime } = require('./ingest-approval-runtime');
const { createIngestHttpRoutes } = require('./ingest-http-routes');
const { createPublicApiRoute } = require('./public-api-route');
const { createReceiptReadRoute } = require('./receipt-read-route');
const { writeStructuredLog } = require('./structured-log');

function createLazyV5PackageRoute({ kernel, parseJsonRequest }) {
  const issuerTrustedKeyRecords = [];
  let cached = null;
  return async function handleV5PackageImportRoute(req, res, reqUrl) {
    if (cached === null) {
      try {
        const { createV5PackageImportRoute, createReceiverTrustedKeyResolver } = require('./v5-package-import-route');
        cached = createV5PackageImportRoute({
          parseJsonRequest,
          trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: issuerTrustedKeyRecords }),
          auditTarget: kernel.graph,
        });
      } catch (_) { cached = () => false; }
    }
    return cached(req, res, reqUrl);
  };
}

function createLazyV5PreflightRoute({ parseJsonRequest }) {
  let cached = null;
  return async function handleV5PreflightRoute(req, res, reqUrl) {
    if (cached === null) {
      try {
        const { createV5PreflightRoute } = require('./v5-preflight-route');
        cached = createV5PreflightRoute({ parseJsonRequest });
      } catch (_) { cached = () => false; }
    }
    return cached(req, res, reqUrl);
  };
}

function createServerRouteRuntime({
  kernel,
  pkg,
  readEnvironment,
  parseJsonRequest,
  denyIfUnauthorized,
  getGraphData,
  createViewerMount,
  createTrustQueryRoutes,
  createOptionalRouteBoundaries,
  createExternalClientProductionBoundary,
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

  const externalClientBoundary = createExternalClientProductionBoundary({
    environment: process.env,
    graph: kernel.graph,
  });
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

  const observabilityRuntime = require('../observability/server-runtime').createObservabilityServerRuntime({
    kernel,
    getStorage: getApprovalStore,
    createAgent,
    parseJsonRequest,
    writeJson,
    denyIfUnauthorized,
    readEnvironment,
  });
  const runtimeStatus = createRuntimeStatusHandlers({
    kernel,
    pkg,
    kernelVersion: CANONICAL_KERNEL_VERSION,
    agentVersion: CANONICAL_AGENT_VERSION,
    agentRuntimeMode: String(readEnvironment('AGENT_RUNTIME') || '').toLowerCase() || CANONICAL_AGENT_VERSION,
    phases: V2_STATUS_PHASES,
    observabilityReadiness: () => observabilityRuntime.getAuthorizationReadiness(),
  });
  const { getHealthData, getV2StatusData } = runtimeStatus;

  const handleWorkflowDataRoute = createWorkflowDataRoutes({
    getApprovalStore,
    decideApproval: args => ingestApprovalRuntime.decide(args),
    readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters),
    parseJsonRequest,
    writeJson,
    proposeLearn: args => callMcpTool(kernel, { name: 'huqan.learn', arguments: args }, { approvalStore: getApprovalStore() }),
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
  const viewerMount = createViewerMount({
    readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters),
  });
  const handleWorkbenchRead = createWorkbenchReadHttpRouter({
    writeJson,
    writeApiError,
    denyIfUnauthorized,
    readTrustFilters,
    readReceiptById,
  });
  const handleAnswerRoute = require('./answer-route').createAnswerRoute({
    kernel,
    legacyVerify,
    sanitizeInput: require('../../requestGuards').sanitizeInput,
    parseJsonRequest,
    denyIfUnauthorized,
    buildCorsHeaders,
    JSON_CONTENT_TYPE,
    DEFAULT_MAX_JSON_BODY: require('../../requestGuards').DEFAULT_MAX_JSON_BODY,
    writeJson,
  });
  const handleFitnessDashboardRoute = createFitnessDashboardRoute({
    kernel,
    writeJson,
    buildCorsHeaders,
    JSON_CONTENT_TYPE,
  });
  const handleCoreRoutes = createCoreHttpRoutes({
    kernel,
    getGraphData,
    getV2StatusData,
    getHealthData,
    handleAnswerRoute,
    parseJsonRequest,
    denyIfUnauthorized,
    buildCorsHeaders,
    writeJson,
    writeApiError,
    legacyVerify,
    JSON_CONTENT_TYPE,
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
  const handlePublicApiRoute = createPublicApiRoute({
    kernel,
    denyIfUnauthorized,
    buildCorsHeaders,
    writeJson,
    JSON_CONTENT_TYPE,
  });
  const handleReceiptReadRoute = createReceiptReadRoute({
    graph: kernel.graph,
    denyIfUnauthorized,
    writeJson,
    writeApiError,
  });
  const { handleTrustQueryRoutes } = createTrustQueryRoutes({
    graph: kernel.graph,
    writeJson,
    writeApiError,
    denyIfUnauthorized,
    readExactWorkspace,
    readTrustFilters,
    hasTrustQuery,
    writeStructuredLog,
  });

  return Object.freeze({
    externalClientBoundary,
    optionalRoutes,
    ingestApprovalRuntime,
    configureHttpHumanOversight: config => ingestApprovalRuntime.configureHumanOversight(config),
    configureHttpAgentIdentity: config => ingestApprovalRuntime.configureAgentIdentity(config),
    handleWorkflowDataRoute,
    handleV5PackageImportRoute: createLazyV5PackageRoute({ kernel, parseJsonRequest }),
    handleV5PreflightRoute: createLazyV5PreflightRoute({ parseJsonRequest }),
    viewerMount,
    handleWorkbenchRead,
    handleReadWorkflow,
    handleObservabilityRoute: observabilityRuntime.handleRoute,
    observabilityRuntime,
    handleFitnessDashboardRoute,
    handleCoreRoutes,
    handleIngestHttpRoutes,
    handlePublicApiRoute,
    handleReceiptReadRoute,
    handleTrustQueryRoutes,
  });
}

module.exports = { createServerRouteRuntime };
