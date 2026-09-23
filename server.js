const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();

const http = require('http');
const path = require('path');
const { readFileSync } = require('fs');
const { createKernel, CANONICAL_KERNEL_VERSION } = require('./lib/kernel-factory');
const { CANONICAL_AGENT_VERSION, createAgent } = require('./agentRuntime');
const { readReceiptById } = require('./lib/receipt/receipt-read-index');
const { createBackgroundTimers } = require('./lib/http/background-timers');
const { createServerLifecycle, requireApiKeyAtBoot } = require('./lib/http/server-boot'), { resolveHttpServerTimeouts, resolveRequestLimits, createConcurrencyLimiter, DEFAULT_RETRY_AFTER_MS } = require('./lib/http/server-timeouts'), { resolveRequestUrl } = require('./lib/http/request-origin');
const { createWorkbenchReadHttpRouter } = require('./lib/workbench/workbench-read-http-router'), { handlePublicBadgeRequest } = require('./lib/http/public-badge-route'), { handleLlmProxyRequest } = require('./lib/llm-proxy/proxy-mount');
const { resolveRouteAuthPolicy } = require('./lib/http/route-auth-policy');
const { handleWorkflowContractRoute } = require('./lib/http/workflow-contract-route');
const { createReadWorkflowHttpRouter } = require('./lib/http/read-workflow-actions');
const { createWorkflowDataRoutes, createLearnApprovalDecision } = require('./lib/http/workflow-data-routes');
const { readExactWorkspace } = require('./lib/http/exact-workspace');
const { createTrustQueryRoutes } = require('./lib/http/trust-query-routes');
// #2128: viewer mount (rate limiter + session store + gateway) lives in
// lib/http/viewer-mount.js; the root keeps the single mount handle.
const { createViewerMount } = require('./lib/http/viewer-mount');
const { createExternalClientProductionBoundary } = require('./lib/external-client-production-boundary');
const { createOptionalRouteBoundaries } = require('./lib/http/optional-boundaries'), { createPrGuardianOptions } = require('./lib/http/pr-guardian-config'), { createFitnessDashboardRoute } = require('./lib/http/fitness-dashboard-route'), { readTrustedBatchKeys } = require('./lib/external-action-receipt-collector'), { readCollectorSealKey } = require('./lib/collector-seal-config');
const { callTool: callMcpTool } = require('./mcpServer');
const pkg = require('./package.json');
const {
  DEFAULT_MAX_UPLOAD_BODY,
  DEFAULT_MAX_JSON_BODY,
  checkRateLimit,
  clearExpiredRateLimitEntries,
  readJsonBody,
  requireApiKey,
  sanitizeInput,
} = require('./requestGuards');
const kernelOpts = {};
const configuredMemoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH');
const configuredDbPath = readCompatibleEnvironmentVariable('DB_PATH');
if (configuredMemoryPath) kernelOpts.memoryPath = configuredMemoryPath;
if (configuredDbPath) kernelOpts.dbPath = configuredDbPath;
if (readCompatibleEnvironmentVariable('USE_SQLITE') === 'false') kernelOpts.useSQLite = false;
const kernel = createKernel(kernelOpts);
kernel.graph.load();
const externalClientBoundary = createExternalClientProductionBoundary({
  environment: process.env,
  graph: kernel.graph,
});
const optionalRoutes = createOptionalRouteBoundaries({ memoryApproval: { kernel, getParseJsonRequest: () => parseJsonRequest, getWriteJson: () => writeJson, approvalRuntime: () => ({ approvalStore: getIngestApprovalStore() }) }, prGuardian: createPrGuardianOptions({ getApprovalStore: getIngestApprovalStore, getParseJsonRequest: () => parseJsonRequest, getWriteJson: () => writeJson }), receiptCollector: { collectorRoot: readCompatibleEnvironmentVariable('RECEIPT_COLLECTOR_ROOT'), getParseJsonRequest: () => parseJsonRequest, trustedKeys: readTrustedBatchKeys(readCompatibleEnvironmentVariable('RECEIPT_TRUSTED_KEYS')), requireSignature: readCompatibleEnvironmentVariable('RECEIPT_REQUIRE_SIGNATURE') === '1', sealKey: readCollectorSealKey() } });
let companyRuntimeReady = false;
const ingestApprovalRuntime = createIngestApprovalRuntime({
  kernel,
  readEnvironment: readCompatibleEnvironmentVariable,
  ensureRuntime: ensureCompanyRuntime,
});
const getIngestApprovalStore = () => ingestApprovalRuntime.getStore();
const configureHttpHumanOversight = config => ingestApprovalRuntime.configureHumanOversight(config);
const configureHttpAgentIdentity = config => ingestApprovalRuntime.configureAgentIdentity(config);

const requestLimits = resolveRequestLimits(readCompatibleEnvironmentVariable);
const concurrencyLimiter = createConcurrencyLimiter({ maxConcurrent: requestLimits.maxConcurrent });
const backgroundTimers = createBackgroundTimers();
backgroundTimers.add(setInterval(() => {
  clearExpiredRateLimitEntries();
}, 60_000));
backgroundTimers.add(setInterval(() => { try { ingestApprovalRuntime.recover(); } catch (error) { writeStructuredLog(console, 'error', 'http.ingest_approval_recovery_error', {}, { runtime: 'http', errorCode: error?.code || 'INGEST_APPROVAL_RECOVERY_FAILED' }); } }, Math.max(5_000, Math.floor(ingestApprovalRuntime.leaseMs / 2))));

const {
  ALLOWED_CORS_HOSTS,
  JSON_CONTENT_TYPE,
  isSafeOrigin,
  buildCorsHeaders,
  memoryContextSecurityHeaders,
  writeJson,
  writeApiError,
  sendOptions,
  getRateLimitKey,
  getSafeMemoryLabel,
  legacyVerify,
} = require('./lib/server-response-helpers');

const {
  TRUST_FILTER_MAX_ID,
  TRUST_FILTER_MAX_REF,
  TRUST_FILTER_MAX_ENUM,
  TRUST_RECEIPT_READ_PREFIX,
  readTrustFilters,
  hasTrustQuery,
} = require('./lib/http-trust-query');
const { V2_STATUS_PHASES } = require('./lib/http/v2-status-phases');
const { buildGraphData } = require('./lib/server-graph-data');
const { createRuntimeStatusHandlers } = require('./lib/http/runtime-status'); const { createRequestCorrelation, writeStructuredLog } = require('./lib/http/structured-log');
const { createCoreHttpRoutes } = require('./lib/http/core-http-routes');
const { createIngestApprovalRuntime } = require('./lib/http/ingest-approval-runtime');
const { createIngestHttpRoutes } = require('./lib/http/ingest-http-routes');
const { createPublicApiRoute } = require('./lib/http/public-api-route');
const { createReceiptReadRoute } = require('./lib/http/receipt-read-route');

const handleWorkflowDataRoute = createWorkflowDataRoutes({ getApprovalStore: getIngestApprovalStore, decideApproval: args => ingestApprovalRuntime.decide(args), readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters), parseJsonRequest, writeJson, proposeLearn: args => callMcpTool(kernel, { name: 'huqan.learn', arguments: args }, { approvalStore: getIngestApprovalStore() }), submitIngest: data => ingestApprovalRuntime.submit(data), createAgent: options => observabilityRuntime.createAgent(options), decideLearnApproval: createLearnApprovalDecision({ kernel, getApprovalStore: getIngestApprovalStore }) });
// V5 issuer records are receiver-owned; an empty registry remains fail-closed.
const issuerTrustedKeyRecords = [];
let v5PackageImportRouteCache = null;
function handleV5PackageImportRoute(req, res, reqUrl) {
  if (v5PackageImportRouteCache === null) {
    try {
      const { createV5PackageImportRoute, createReceiverTrustedKeyResolver } = require('./lib/http/v5-package-import-route');
      v5PackageImportRouteCache = createV5PackageImportRoute({
        parseJsonRequest,
        trustedKeyResolver: createReceiverTrustedKeyResolver({ issuerRecords: issuerTrustedKeyRecords }),
        auditTarget: kernel.graph,
      });
    } catch (_) { v5PackageImportRouteCache = () => false; }
  }
  return v5PackageImportRouteCache(req, res, reqUrl);
}
let v5PreflightRouteCache = null;
function handleV5PreflightRoute(req, res, reqUrl) {
  if (v5PreflightRouteCache === null) {
    try {
      const { createV5PreflightRoute } = require('./lib/http/v5-preflight-route');
      v5PreflightRouteCache = createV5PreflightRoute({ parseJsonRequest });
    } catch (_) { v5PreflightRouteCache = () => false; }
  }
  return v5PreflightRouteCache(req, res, reqUrl);
}
const viewerMount = createViewerMount({
  readReceipt: (receiptId, filters) => readReceiptById(kernel.graph, receiptId, filters),
});

function denyIfUnauthorized(req, res, extraHeaders = {}, options = {}) {
  const auth = requireApiKey(req);
  if (auth.ok) { req.huqanAuth = Object.freeze({ subject: 'local-api-key' }); return true; }
  writeJson(req, res, auth.status, options.errorCode ? { ok: false, error: { code: options.errorCode, message: 'Unauthorized.' } } : auth.error, { ...auth.headers, ...extraHeaders });
  return false;
}

const handleWorkbenchRead = createWorkbenchReadHttpRouter({
  writeJson,
  writeApiError,
  denyIfUnauthorized,
  readTrustFilters,
  readReceiptById,
});

async function parseJsonRequest(req, res, options = {}) {
  const result = await readJsonBody(req, options);
  if (result.ok) return result.data;
  writeJson(req, res, result.status, result.error, result.headers);
  return null;
}

function getGraphData(workspaceId = 'default') {
  return buildGraphData({ graph: kernel.graph, memory: kernel.memory, getSafeMemoryLabel, workspaceId });
}

// Issue #1825: expose whether the observability authorization policy is
// configured through /v2-status so the Command Center can render a truthful
// NOT CONFIGURED state. Hoisted function: observabilityRuntime is declared
// later in this file, but this is only called once a request arrives.
function observabilityReadiness() {
  return observabilityRuntime.getAuthorizationReadiness();
}
const runtimeStatus = createRuntimeStatusHandlers({
  kernel,
  pkg,
  kernelVersion: CANONICAL_KERNEL_VERSION,
  agentVersion: CANONICAL_AGENT_VERSION,
  agentRuntimeMode: String(readCompatibleEnvironmentVariable('AGENT_RUNTIME') || '').toLowerCase() || CANONICAL_AGENT_VERSION,
  phases: V2_STATUS_PHASES,
  observabilityReadiness,
});
const { getHealthData, getV2StatusData } = runtimeStatus;

function ensureCompanyRuntime() {
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
    kernel.enableCapability('companyMode');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
    kernel.enableCapability('pluginCapabilities');
  }
  if (!companyRuntimeReady && kernel.plugins && typeof kernel.plugins.load === 'function') {
    kernel.plugins.load(path.join(__dirname, 'plugins'));
    companyRuntimeReady = true;
  }
}
const handleReadWorkflow = createReadWorkflowHttpRouter({ kernel, parseJsonRequest, writeJson, writeApiError, ensureCapabilities: ensureCompanyRuntime });
const observabilityRuntime = require('./lib/observability/server-runtime').createObservabilityServerRuntime({
  kernel,
  getStorage: getIngestApprovalStore,
  createAgent,
  parseJsonRequest,
  writeJson,
  denyIfUnauthorized,
  readEnvironment: readCompatibleEnvironmentVariable,
});
const handleObservabilityRoute = observabilityRuntime.handleRoute;
// The index page and every asset it links are served from one declared table,
// so extracting CSS or JS out of public/index.html cannot leave the browser with
// a 404 the way #1894 did. See lib/http/static-assets.js.
const { getHtmlPage, handleStaticAssetRequest } = require('./lib/http/static-assets');
const handleAnswerRoute = require('./lib/http/answer-route').createAnswerRoute({ kernel, legacyVerify, sanitizeInput, parseJsonRequest, denyIfUnauthorized, buildCorsHeaders, JSON_CONTENT_TYPE, DEFAULT_MAX_JSON_BODY, writeJson }), handleFitnessDashboardRoute = createFitnessDashboardRoute({ kernel, writeJson, buildCorsHeaders, JSON_CONTENT_TYPE });
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
const server = http.createServer(resolveHttpServerTimeouts(readCompatibleEnvironmentVariable), async (req, res) => {
  if (!concurrencyLimiter.tryAcquire()) { res.writeHead(503, { 'Content-Type': JSON_CONTENT_TYPE, 'Retry-After': String(Math.ceil(DEFAULT_RETRY_AFTER_MS / 1000)), 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: { code: 'service_unavailable', message: 'Server at capacity' } })); return; }
  let cr=false;const rel=()=>{if(!cr){cr=true;concurrencyLimiter.release();}};res.on('finish',rel);res.on('close',rel);
  const correlation = createRequestCorrelation(req, res); try {
  res.setHeader('Connection', 'close');
  const rawPath = String(req.url || '').split('?', 1)[0].split('#', 1)[0];
  // Resolved once, before any route -- a malformed client-controlled Host is
  // the client's mistake, not an internal fault; see lib/http/request-origin.js.
  const reqUrl = resolveRequestUrl(req); if (reqUrl === null) return writeJson(req, res, 400, { error: 'Bad request' });
  if (viewerMount.isViewerPath(rawPath)) {
    if (!viewerMount.checkRateLimit(req)) {
      res.writeHead(429, { 'Content-Type': JSON_CONTENT_TYPE, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }));
      return;
    }
    await viewerMount.handle(req, res, reqUrl);
    return;
  }
  if (req.method === 'OPTIONS') {
    sendOptions(req, res);
    return;
  }

  const rateKey = getRateLimitKey(req);

  if (!checkRateLimit(rateKey)) {
    res.writeHead(429, {
      'Content-Type': JSON_CONTENT_TYPE,
      ...memoryContextSecurityHeaders(rawPath),
    });
    res.end(JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }));
    return;
  }

  const routeAuthPolicy = resolveRouteAuthPolicy(reqUrl.pathname, req.method, {
    workspaceId: sanitizeInput(reqUrl.searchParams.get('workspaceId') || ''),
    externalClientRouteEnabled: externalClientBoundary !== null,
    ...optionalRoutes.authContext,
  });
  if (routeAuthPolicy.authRequired
    && !denyIfUnauthorized(req, res, memoryContextSecurityHeaders(rawPath), routeAuthPolicy.ruleId === 'observability' ? { errorCode: 'UNAUTHORIZED' } : {})) return;
  if (!routeAuthPolicy.known) {
    res.writeHead(404, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (externalClientBoundary && reqUrl.pathname === externalClientBoundary.path) {
    const descriptor = await externalClientBoundary.handle(req);
    res.writeHead(descriptor.statusCode, descriptor.headers);
    res.end(JSON.stringify(descriptor.body));
    return;
  }

  if (await optionalRoutes.route(req, res, reqUrl)) return;
  if (await handleObservabilityRoute(req, res, reqUrl)) return;
  if (await handleV5PackageImportRoute(req, res, reqUrl)) return;
  if (await handleV5PreflightRoute(req, res, reqUrl)) return;
  if (handleWorkflowContractRoute(req, res, reqUrl) || await handleReadWorkflow(req, res, reqUrl)) return;
  if (await handleWorkflowDataRoute(req, res, reqUrl) || await handleFitnessDashboardRoute(req, res, reqUrl)) return;
  if (await handleCoreRoutes(req, res, reqUrl, correlation)) return;

  if (await handleIngestHttpRoutes(req, res, reqUrl, correlation)) return;

  if (handleReceiptReadRoute(req, res, reqUrl)) return;

  if (handlePublicBadgeRequest({ req, res, reqUrl, source: kernel.graph, writeJson }) || await handleLlmProxyRequest(req, res, reqUrl, { graph: kernel.graph, writeJson }) || handleWorkbenchRead(req, res, reqUrl, kernel.graph)) return;

  if (handleTrustQueryRoutes(req, res, reqUrl, correlation)) return;

  if (await handlePublicApiRoute(req, res, reqUrl, correlation)) return;

  // --- Ana sayfa ve panelin linkli statik varlıkları ---
  // An undeclared path falls through to the generic 404 below.
  if (handleStaticAssetRequest(req, res, reqUrl.pathname, {
    buildCorsHeaders,
    writeJson,
    onError: (asset, err) => writeStructuredLog(console, 'error', 'http.static_asset_error', correlation, { route: asset.pathname, method: req.method, errorCode: err?.code || asset.logCode }),
  })) return;

  res.writeHead(404, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
  res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    writeStructuredLog(console, 'error', 'http.unhandled_error', correlation, { route: String(req.url || '').split('?', 1)[0], method: req.method, errorCode: err?.code || 'HTTP_UNHANDLED_ERROR' });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': JSON_CONTENT_TYPE });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const PORT = process.env.PORT || 3000;
const HOST = readCompatibleEnvironmentVariable('HOST') || '127.0.0.1';

function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    const address = server.address();
    const boundHost = typeof address === 'object' && address ? address.address : host;
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`🧠 HUQAN web interface: http://${boundHost}:${boundPort}`);
    console.log(`   Graph view: http://${boundHost}:${boundPort} → "Graph" tab`);
  });
}

function startAgentWorkerIfEnabled() {
  return observabilityRuntime.startWorkerIfEnabled();
}

function closeHuqan() {
  observabilityRuntime.stop();
  backgroundTimers.clearAll();
  viewerMount.reset();
  ingestApprovalRuntime.close();
  try { externalClientBoundary?.close(); } catch (_) {}
  kernel.graph.close();
}

const serverLifecycle = createServerLifecycle({ server, closeResources: closeHuqan });

if (require.main === module && readCompatibleEnvironmentVariable('DISABLE_AUTO_LISTEN') !== '1') {
  try {
    requireApiKeyAtBoot();
  } catch (error) {
    console.error(`HUQAN server cannot start: ${error.message} (code=${error.code || 'STARTUP_VALIDATION_FAILED'})`);
    process.exitCode = 1;
    process.exit(1);
  }
  serverLifecycle.bind();
  startAgentWorkerIfEnabled();
  startServer(PORT, HOST);
}

server.closeHuqan = server.closeAxiom = closeHuqan; server.bindGracefulShutdown = serverLifecycle.bind; // closeAxiom: RFC-001 legacy alias

server.startServer = startServer;
server.configureHttpHumanOversight = configureHttpHumanOversight;
server.configureHttpAgentIdentity = configureHttpAgentIdentity;
// Exposed for tests that need to assert against the same kernel/graph
// instance the HTTP handlers use (e.g. checking audit events a request
// produced). server.js owns this kernel directly now (#326); it is no
// longer reachable by intercepting a CLI instance server.js used to build.
server.kernel = kernel;
server.concurrencyLimiter = concurrencyLimiter;
server.requestLimits = requestLimits;
module.exports = server;
module.exports.getRateLimitKey = getRateLimitKey;
// Exposed so the index-page cache (#420) can be asserted directly, without
// having to intercept fs from outside the module.
module.exports.getHtmlPage = getHtmlPage;

