'use strict';

const http = require('node:http');
const {
  readCompatibleEnvironmentVariable,
} = require('./lib/environment-compat');
const {
  createGitHubAppBetaHttpBoundary,
} = require('./lib/github-app-beta-http-boundary');

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';
const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function startupFail(message) {
  const error = new Error(message);
  error.code = 'GITHUB_APP_BETA_STARTUP_INVALID';
  throw error;
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(String(value))) startupFail('GitHub App beta port is invalid');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    startupFail('GitHub App beta port is invalid');
  }
  return port;
}

function parseHost(value) {
  if (value === undefined || value === '') return DEFAULT_HOST;
  if (typeof value !== 'string' || value.length > 255 || /[\s/\\]/.test(value)) {
    startupFail('GitHub App beta host is invalid');
  }
  return value;
}

function createGitHubAppBetaServer({ boundary } = {}) {
  if (!boundary || typeof boundary.path !== 'string' || typeof boundary.handle !== 'function') {
    startupFail('GitHub App beta HTTP boundary is required');
  }

  return http.createServer(async (req, res) => {
    res.setHeader('Connection', 'close');
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (reqUrl.pathname !== boundary.path) {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
        return;
      }

      const result = await boundary.handle(req);
      res.writeHead(result.statusCode, result.headers);
      res.end(JSON.stringify(result.body));
    } catch (_) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: { code: 'GITHUB_APP_BETA_INTERNAL_ERROR' } }));
    }
  });
}

function buildProductionBoundary(environment = process.env) {
  const boundary = createGitHubAppBetaHttpBoundary({ environment });
  if (!boundary) startupFail('GitHub App beta is disabled');
  return boundary;
}

function startGitHubAppBetaServer(options = {}) {
  const environment = options.environment || process.env;
  const boundary = options.boundary || buildProductionBoundary(environment);
  const port = options.port ?? parsePort(readCompatibleEnvironmentVariable('GITHUB_APP_PORT', environment));
  const host = options.host ?? parseHost(readCompatibleEnvironmentVariable('GITHUB_APP_HOST', environment));
  const server = createGitHubAppBetaServer({ boundary });
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(`HUQAN GitHub App beta webhook listening on http://${host}:${boundPort}${boundary.path}`);
  });
  return server;
}

if (require.main === module) startGitHubAppBetaServer();

module.exports = Object.freeze({
  DEFAULT_PORT,
  DEFAULT_HOST,
  createGitHubAppBetaServer,
  buildProductionBoundary,
  startGitHubAppBetaServer,
});
