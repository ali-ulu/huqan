const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();

const http = require('http');
const { createKernel } = require('./lib/kernel-factory');
const { createBackgroundTimers } = require('./lib/http/background-timers');
const { createServerLifecycle, requireApiKeyAtBoot } = require('./lib/http/server-boot'), { resolveHttpServerTimeouts, resolveRequestLimits, createConcurrencyLimiter } = require('./lib/http/server-timeouts');
const { createTrustQueryRoutes } = require('./lib/http/trust-query-routes');
const { createViewerMount } = require('./lib/http/viewer-mount');
const { createExternalClientProductionBoundary } = require('./lib/external-client-production-boundary');
const { CANONICAL_AGENT_VERSION, createAgent } = require('./agentRuntime');
const { callTool: callMcpTool } = require('./mcpServer');
const { createServerRouteRuntime } = require('./lib/http/server-route-runtime');
const { createServerRequestHandler } = require('./lib/http/server-request-handler');
const { createOptionalRouteBoundaries } = require('./lib/http/optional-boundaries');
const pkg = require('./package.json');
const {
  clearExpiredRateLimitEntries,
  readJsonBody,
  requireApiKey,
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
  writeJson,
  getRateLimitKey,
  getSafeMemoryLabel,
} = require('./lib/server-response-helpers');

const { buildGraphData } = require('./lib/server-graph-data');
const { writeStructuredLog } = require('./lib/http/structured-log');

function denyIfUnauthorized(req, res, extraHeaders = {}, options = {}) {
  const auth = requireApiKey(req);
  if (auth.ok) {
    req.huqanAuth = Object.freeze({ subject: 'local-api-key' });
    return true;
  }
  writeJson(
    req,
    res,
    auth.status,
    options.errorCode
      ? { ok: false, error: { code: options.errorCode, message: 'Unauthorized.' } }
      : auth.error,
    { ...auth.headers, ...extraHeaders },
  );
  return false;
}

async function parseJsonRequest(req, res, options = {}) {
  const result = await readJsonBody(req, options);
  if (result.ok) return result.data;
  writeJson(req, res, result.status, result.error, result.headers);
  return null;
}

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
  createAgent,
  callMcpTool,
  agentVersion: CANONICAL_AGENT_VERSION,
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

const requestHandler = createServerRequestHandler({
  kernel,
  concurrencyLimiter,
  denyIfUnauthorized,
  viewerMount,
  externalClientBoundary,
  optionalRoutes,
  handleObservabilityRoute,
  handleV5PackageImportRoute,
  handleV5PreflightRoute,
  handleReadWorkflow,
  handleWorkflowDataRoute,
  handleFitnessDashboardRoute,
  handleCoreRoutes,
  handleIngestHttpRoutes,
  handleReceiptReadRoute,
  handleWorkbenchRead,
  handleTrustQueryRoutes,
  handlePublicApiRoute,
});
const server = http.createServer(
  resolveHttpServerTimeouts(readCompatibleEnvironmentVariable),
  requestHandler,
);

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
server.kernel = kernel;
server.concurrencyLimiter = concurrencyLimiter;
server.requestLimits = requestLimits;
module.exports = server;
module.exports.getRateLimitKey = getRateLimitKey;
module.exports.getHtmlPage = require('./lib/http/static-assets').getHtmlPage;

