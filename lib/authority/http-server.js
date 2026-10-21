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
const fs = require('node:fs');
const { signResponse, requestDigestOf } = require('./decision-envelope');
const { isSafeSocketPath } = require('./authority-pin');

const MAX_BODY_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const HEADERS_TIMEOUT_MS = 5 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
const MAX_CONNECTIONS = 64;
// A unix socket carries no DNS to rebind, and node's own client sends
// `Host: localhost`; the TCP check still names the exact loopback authority.
const SOCKET_HOST = 'localhost';
// Owner + one named group. 0660 is the whole point of the socket: TCP loopback
// is reachable by every local user, but only this group can open the socket.
const SOCKET_MODE = 0o660;
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
  if (method === 'GET' && url.pathname === '/v1/ledger/anchor') return service.ledgerAnchor();
  if (method === 'GET' && url.pathname === '/v1/ledger') {
    return service.ledgerEntries({ fromSeq: Number.parseInt(query.fromSeq, 10), limit: Number.parseInt(query.limit, 10) });
  }
  if (method === 'POST' && url.pathname === '/v1/stops') return service.recordStop(body);
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
  const address = server.address();
  // Transport-sensitive host check: a TCP authority must name its exact
  // loopback `host:port` (no DNS rebinding), a unix socket has no DNS and
  // node's client sends `localhost`.
  const expectedHost = typeof address === 'string' ? SOCKET_HOST : `127.0.0.1:${address.port}`;
  if (request.headers.host !== expectedHost) return plain(response, 421, 'MISDIRECTED');
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
  return sign(route(service, request.method, new URL(request.url, `http://${expectedHost}`), body));
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

/**
 * A socket path is trusted only as a plain absolute path with no `..` segment:
 * a relative path or one the server would normalise differently than the pin
 * spells it would bind somewhere the pin does not name. The rule lives with the
 * pin field; this is the same predicate, so the two cannot drift.
 */
function assertSocketPathSafe(socketPath) {
  if (!isSafeSocketPath(socketPath)) {
    throw new Error(`refusing a socket path that is not a plain absolute path: ${JSON.stringify(socketPath)}`);
  }
  return socketPath;
}

/**
 * Remove a leftover socket file before a restart binds it, and nothing else.
 * A path that is a symlink or is not a socket is refused rather than unlinked:
 * the directory is root- and group-owned, so anything else there is a plant.
 * An absent path is not a finding -- the first start has nothing to clear.
 */
function clearStaleSocket(socketPath, { lstat = fs.lstatSync, unlink = fs.unlinkSync } = {}) {
  assertSocketPathSafe(socketPath);
  let stat;
  try {
    stat = lstat(socketPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw new Error(`refusing to clear the socket path: ${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing to clear a symlinked socket path: ${socketPath}`);
  if (!stat.isSocket()) throw new Error(`refusing to clear a non-socket at the socket path: ${socketPath}`);
  unlink(socketPath);
  return true;
}

/**
 * Force the socket to `0660` and prove it, after `listen`. Node creates it
 * under the process umask, so a 0022 umask leaves 0755 -- readable and, worse,
 * connectable by every local user. The mode is re-read, so a chmod that
 * silently did nothing is a refusal, not a pass. The path must already be a
 * socket: a symlink or a regular file there is a plant in a root-owned dir.
 */
function secureSocket(socketPath, { lstat = fs.lstatSync, chmod = fs.chmodSync } = {}) {
  assertSocketPathSafe(socketPath);
  const before = lstat(socketPath);
  if (before.isSymbolicLink()) throw new Error(`refusing a symlinked socket path: ${socketPath}`);
  if (!before.isSocket()) throw new Error(`refusing a socket path that is not a socket: ${socketPath}`);
  chmod(socketPath, SOCKET_MODE);
  const after = lstat(socketPath);
  if ((after.mode & 0o777) !== SOCKET_MODE) {
    throw new Error(`the socket mode is ${(after.mode & 0o777).toString(8)}, not 660`);
  }
  return socketPath;
}

module.exports = { MAX_BODY_BYTES, SOCKET_MODE, SOCKET_HOST, createAuthorityServer, assertSocketPathSafe, clearStaleSocket, secureSocket };
