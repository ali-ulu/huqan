const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();

const http = require('http');
const { createKernel } = require('./lib/kernel-factory');
const { createBackgroundTimers } = require('./lib/http/background-timers');
const { createServerLifecycle, requireApiKeyAtBoot } = require('./lib/http/server-boot'), { resolveHttpServerTimeouts, resolveRequestLimits, createConcurrencyLimiter, DEFAULT_RETRY_AFTER_MS } = require('./lib/http/server-timeouts'), { resolveRequestUrl } = require('./lib/http/request-origin');
const { handlePublicBadgeRequest } = require('./lib/http/public-badge-route'), { handleLlmProxyRequest } = require('./lib/llm-proxy/proxy-mount');
const { resolveRouteAuthPolicy } = require('./lib/http/route-auth-policy');
const { handleWorkflowContractRoute } = require('./lib/http/workflow-contract-route');
const { createTrustQueryRoutes } = require('./lib/http/trust-query-routes');
// #2128: viewer mount (rate limiter + session store + gateway) lives in
// lib/http/viewer-mount.js; the root keeps the single mount handle.
const { createViewerMount } = require('./lib/http/viewer-mount');
const { createExternalClientProductionBoundary } = require('./lib/external-client-production-boundary');
const { createServerRouteRuntime } = require('./lib/http/server-route-runtime');
const { createOptionalRouteBoundaries } = require('./lib/http/optional-boundaries');
const pkg = require('./package.json');
const {
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
const requestLimits = resolveRequestLimits(readCompatibleEnvironmentVariable);
const concurrencyLimiter = createConcurrencyLimiter({ maxConcurrent: requestLimits.maxConcurrent });
const backgroundTimers = createBackgroundTimers();
backgroundTimers.add(setInterval(() => {
  clearExpiredRateLimitEntries();
}, 60_000));

const {
  JSON_CONTENT_TYPE,
  buildCorsHeaders,
  memoryContextSecurityHeaders,
  writeJson,
  sendOptions,
  getRateLimitKey,
  getSafeMemoryLabel,
} = require('./lib/server-response-helpers');

const { buildGraphData } = require('./lib/server-graph-data');
const { createRequestCorrelation, writeStructuredLog } = require('./lib/http/structured-log');

const routeRuntime = createServerRouteRuntime({
  kernel,
  pkg,
  readEnvironment: readCompatibleEnvironmentVariable,
  parseJsonRequest,
  denyIfUnauthorized,
  getGraphData,
  createViewerMount,
  createTrustQueryRoutes,
  createOptionalRouteBoundaries,
  createExternalClientProductionBoundary,
});
const {
  externalClientBoundary,
  optionalRoutes,
  ingestApprovalRuntime,
  configureHttpHumanOversight,
  configureHttpAgentIdentity,
  handleWorkflowDataRoute,
  handleV5PackageImportRoute,
  handleV5PreflightRoute,
  viewerMount,
  handleWorkbenchRead,
  handleReadWorkflow,
  handleObservabilityRoute,
  observabilityRuntime,
  handleFitnessDashboardRoute,
  handleCoreRoutes,
  handleIngestHttpRoutes,
  handlePublicApiRoute,
  handleReceiptReadRoute,
  handleTrustQueryRoutes,
} = routeRuntime;
backgroundTimers.add(setInterval(() => {
  try { ingestApprovalRuntime.recover(); }
  catch (error) {
    writeStructuredLog(console, 'error', 'http.ingest_approval_recovery_error', {}, {
      runtime: 'http',
      errorCode: error?.code || 'INGEST_APPROVAL_RECOVERY_FAILED',
    });
  }
}, Math.max(5_000, Math.floor(ingestApprovalRuntime.leaseMs / 2))));

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

function getGraphData(workspaceId = 'default') {
  return buildGraphData({ graph: kernel.graph, memory: kernel.memory, getSafeMemoryLabel, workspaceId });
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

