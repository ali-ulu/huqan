'use strict';

const { DEFAULT_RETRY_AFTER_MS } = require('./server-timeouts');
const { resolveRequestUrl } = require('./request-origin');
const { resolveRouteAuthPolicy } = require('./route-auth-policy');
const { handleWorkflowContractRoute } = require('./workflow-contract-route');
const { handlePublicBadgeRequest } = require('./public-badge-route');
const { handleLlmProxyRequest } = require('../llm-proxy/proxy-mount');
const { handleStaticAssetRequest } = require('./static-assets');
const { checkRateLimit, sanitizeInput } = require('../../requestGuards');
const {
  JSON_CONTENT_TYPE,
  buildCorsHeaders,
  memoryContextSecurityHeaders,
  writeJson,
  sendOptions,
  getRateLimitKey,
} = require('../server-response-helpers');
const { createRequestCorrelation, writeStructuredLog } = require('./structured-log');

function createServerRequestHandler({
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
}) {
  return async function handleServerRequest(req, res) {
    if (!concurrencyLimiter.tryAcquire()) {
      res.writeHead(503, {
        'Content-Type': JSON_CONTENT_TYPE,
        'Retry-After': String(Math.ceil(DEFAULT_RETRY_AFTER_MS / 1000)),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'service_unavailable', message: 'Server at capacity' },
      }));
      return;
    }
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        concurrencyLimiter.release();
      }
    };
    res.on('finish', release);
    res.on('close', release);

    const correlation = createRequestCorrelation(req, res);
    try {
      res.setHeader('Connection', 'close');
      const rawPath = String(req.url || '').split('?', 1)[0].split('#', 1)[0];
      const reqUrl = resolveRequestUrl(req);
      if (reqUrl === null) return writeJson(req, res, 400, { error: 'Bad request' });

      if (viewerMount.isViewerPath(rawPath)) {
        if (!viewerMount.checkRateLimit(req)) {
          res.writeHead(429, {
            'Content-Type': JSON_CONTENT_TYPE,
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({
            ok: false,
            error: { code: 'rate_limited', message: 'Too many requests' },
          }));
          return;
        }
        await viewerMount.handle(req, res, reqUrl);
        return;
      }

      if (req.method === 'OPTIONS') {
        sendOptions(req, res);
        return;
      }

      if (!checkRateLimit(getRateLimitKey(req))) {
        res.writeHead(429, {
          'Content-Type': JSON_CONTENT_TYPE,
          ...memoryContextSecurityHeaders(rawPath),
        });
        res.end(JSON.stringify({
          ok: false,
          error: { code: 'rate_limited', message: 'Too many requests' },
        }));
        return;
      }

      const routeAuthPolicy = resolveRouteAuthPolicy(reqUrl.pathname, req.method, {
        workspaceId: sanitizeInput(reqUrl.searchParams.get('workspaceId') || ''),
        externalClientRouteEnabled: externalClientBoundary !== null,
        ...optionalRoutes.authContext,
      });
      if (routeAuthPolicy.authRequired
        && !denyIfUnauthorized(
          req,
          res,
          memoryContextSecurityHeaders(rawPath),
          routeAuthPolicy.ruleId === 'observability' ? { errorCode: 'UNAUTHORIZED' } : {},
        )) return;
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
      if (handleWorkflowContractRoute(req, res, reqUrl)
        || await handleReadWorkflow(req, res, reqUrl)) return;
      if (await handleWorkflowDataRoute(req, res, reqUrl)
        || await handleFitnessDashboardRoute(req, res, reqUrl)) return;
      if (await handleCoreRoutes(req, res, reqUrl, correlation)) return;
      if (await handleIngestHttpRoutes(req, res, reqUrl, correlation)) return;
      if (handleReceiptReadRoute(req, res, reqUrl)) return;
      if (handlePublicBadgeRequest({ req, res, reqUrl, source: kernel.graph, writeJson })
        || await handleLlmProxyRequest(req, res, reqUrl, { graph: kernel.graph, writeJson })
        || handleWorkbenchRead(req, res, reqUrl, kernel.graph)) return;
      if (handleTrustQueryRoutes(req, res, reqUrl, correlation)) return;
      if (await handlePublicApiRoute(req, res, reqUrl, correlation)) return;

      if (handleStaticAssetRequest(req, res, reqUrl.pathname, {
        buildCorsHeaders,
        writeJson,
        onError: (asset, err) => writeStructuredLog(
          console,
          'error',
          'http.static_asset_error',
          correlation,
          {
            route: asset.pathname,
            method: req.method,
            errorCode: err?.code || asset.logCode,
          },
        ),
      })) return;

      res.writeHead(404, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      writeStructuredLog(console, 'error', 'http.unhandled_error', correlation, {
        route: String(req.url || '').split('?', 1)[0],
        method: req.method,
        errorCode: err?.code || 'HTTP_UNHANDLED_ERROR',
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': JSON_CONTENT_TYPE });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  };
}

module.exports = { createServerRequestHandler };
