'use strict';

// The approval authority's HTTP surface (#3860, ADR-016 item 5).
//
// Bound to 127.0.0.1 only. A request must name exactly that host (no DNS
// rebinding), carry no Origin (no browser page can drive it), and bring a
// 32-byte challenge. Every answer -- refusals included -- is signed over that
// challenge and the request it answers, with the status code inside the signed
// body, so a client never acts on an answer the authority did not give to this
// request. No CORS headers are ever sent.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const http = require('node:http');
const { signResponse, requestDigestOf } = require('./decision-envelope');

const MAX_BODY_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const HEADERS_TIMEOUT_MS = 5 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
const MAX_CONNECTIONS = 64;
const TOO_LARGE = Symbol('too large');
const ABORTED = Symbol('aborted');
const CHALLENGE = /^[0-9a-f]{64}$/;
const APPROVAL_ROUTE = /^\/v1\/approvals\/([A-Za-z0-9_.:-]{1,128})(?:\/(decision|withdraw|consume|outcome))?$/;
const BASE_HEADERS = Object.freeze({ 'content-type': 'application/json', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff' });

function plain(response, status, code) {
  response.writeHead(status, BASE_HEADERS);
  response.end(JSON.stringify({ code }));
}

function route(service, method, url, body) {
  const query = Object.fromEntries(url.searchParams);
  if (method === 'GET' && url.pathname === '/v1/identity') return service.identity();
  if (method === 'GET' && url.pathname === '/v1/ledger/head') return service.ledgerHead();
  if (method === 'GET' && url.pathname === '/v1/ledger') {
    return service.ledgerEntries({ fromSeq: Number.parseInt(query.fromSeq, 10), limit: Number.parseInt(query.limit, 10) });
  }
  if (url.pathname === '/v1/approvals') {
    if (method === 'POST') return service.register(body);
    if (method === 'GET') return service.list({ status: query.status, workspaceId: query.workspaceId });
  }
  const match = APPROVAL_ROUTE.exec(url.pathname);
  if (match) {
    const [, approvalId, action] = match;
    if (!action && method === 'GET') return service.show(approvalId);
    if (action === 'decision' && method === 'GET') return service.getDecision(approvalId);
    if (action === 'decision' && method === 'POST') return service.decide(approvalId, body?.sealed);
    if (action === 'withdraw' && method === 'POST') return service.withdraw(approvalId, body?.sealed);
    if (action === 'consume' && method === 'POST') return service.consume(approvalId, body || {});
    if (action === 'outcome' && method === 'POST') return service.recordOutcome(approvalId, body || {});
  }
  return { status: 404, body: { code: 'NO_ROUTE' } };
}

// Settles with the body, with TOO_LARGE as soon as the cap is passed (the
// rest is never read), or with ABORTED when the client goes away first, so no
// handler waits forever on a half-sent request.
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (value) => {
      if (!settled) { settled = true; resolve(value); }
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return settle(TOO_LARGE);
      chunks.push(chunk);
      return undefined;
    });
    request.on('end', () => settle(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => settle(ABORTED));
    request.on('close', () => settle(ABORTED));
  });
}

function parseBody(raw, request) {
  if (!raw) return { body: undefined };
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    return { refusal: { status: 415, body: { code: 'JSON_REQUIRED' } } };
  }
  try { return { body: JSON.parse(raw) }; } catch { return { refusal: { status: 400, body: { code: 'MALFORMED_JSON' } } }; }
}

async function handle(server, service, signingKey, request, response) {
  const { port } = server.address();
  if (request.headers.host !== `127.0.0.1:${port}`) return plain(response, 421, 'MISDIRECTED');
  if (request.headers.origin !== undefined) return plain(response, 403, 'BROWSER_REFUSED');
  const challenge = request.headers['x-huqan-challenge'];
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return plain(response, 400, 'CHALLENGE_REQUIRED');
  const raw = await readBody(request);
  if (raw === ABORTED) return undefined;
  const sign = ({ status, body }) => {
    const signed = signResponse({ status, body }, { challenge, method: request.method, path: request.url,
      requestDigest: requestDigestOf(typeof raw === 'string' ? raw : '') }, signingKey);
    response.writeHead(status, raw === TOO_LARGE ? { ...BASE_HEADERS, connection: 'close' } : BASE_HEADERS);
    response.end(JSON.stringify(signed), () => { if (raw === TOO_LARGE) request.destroy(); });
  };
  if (raw === TOO_LARGE) return sign({ status: 413, body: { code: 'TOO_LARGE' } });
  const { body, refusal } = parseBody(raw, request);
  if (refusal) return sign(refusal);
  return sign(route(service, request.method, new URL(request.url, `http://127.0.0.1:${port}`), body));
}

function createAuthorityServer({ service, signingKey }) {
  const server = http.createServer((request, response) => {
    // One guard around everything: a throw anywhere -- signing included --
    // becomes a 500 or a dropped socket, never an unhandled rejection that
    // would take the service down.
    handle(server, service, signingKey, request, response).catch(() => {
      if (!response.headersSent) plain(response, 500, 'INTERNAL');
      else response.destroy();
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

module.exports = { MAX_BODY_BYTES, createAuthorityServer };
