'use strict';

const { CANONICAL_KERNEL_VERSION } = require('../kernel-factory');
const { readReceiptById } = require('../receipt/receipt-read-index');
const { createWorkbenchReadHttpRouter } = require('../workbench/workbench-read-http-router');
const { readExactWorkspace } = require('./exact-workspace');
const { createFitnessDashboardRoute } = require('./fitness-dashboard-route');
const {
  JSON_CONTENT_TYPE,
  buildCorsHeaders,
  writeJson,
  writeApiError,
  legacyVerify,
} = require('../server-response-helpers');
const { readTrustFilters, hasTrustQuery } = require('../http-trust-query');
const { V2_STATUS_PHASES } = require('./v2-status-phases');
const { createRuntimeStatusHandlers } = require('./runtime-status');
const { createCoreHttpRoutes } = require('./core-http-routes');
const { createPublicApiRoute } = require('./public-api-route');
const { createReceiptReadRoute } = require('./receipt-read-route');
const { writeStructuredLog } = require('./structured-log');
const { createAnswerRoute } = require('./answer-route');
const { sanitizeInput, DEFAULT_MAX_JSON_BODY } = require('../../requestGuards');

function createReadRouteRuntime({
  kernel,
  pkg,
  readEnvironment,
  parseJsonRequest,
  denyIfUnauthorized,
  getGraphData,
  observabilityRuntime,
  createViewerMount,
  createTrustQueryRoutes,
  agentVersion,
}) {
  const runtimeStatus = createRuntimeStatusHandlers({
    kernel,
    pkg,
    kernelVersion: CANONICAL_KERNEL_VERSION,
    agentVersion,
    agentRuntimeMode: String(readEnvironment('AGENT_RUNTIME') || '').toLowerCase()
      || agentVersion,
    phases: V2_STATUS_PHASES,
    observabilityReadiness: () => observabilityRuntime.getAuthorizationReadiness(),
  });
  const { getHealthData, getV2StatusData } = runtimeStatus;

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
  const handleAnswerRoute = createAnswerRoute({
    kernel,
    legacyVerify,
    sanitizeInput,
    parseJsonRequest,
    denyIfUnauthorized,
    buildCorsHeaders,
    JSON_CONTENT_TYPE,
    DEFAULT_MAX_JSON_BODY,
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
    viewerMount,
    handleWorkbenchRead,
    handleFitnessDashboardRoute,
    handleCoreRoutes,
    handlePublicApiRoute,
    handleReceiptReadRoute,
    handleTrustQueryRoutes,
  });
}

module.exports = { createReadRouteRuntime };
