'use strict';

// The protected loopback transport of an MCP server (ADR-017 §4, ADR-018 §3/§4,
// #3999): an http.Server on 127.0.0.1 that answers a JSON-RPC request only
// after the request's client envelope verifies in the seven ordered fail-closed
// steps of docs/mcp-client-envelope-spec.md.
//
// The wire contract:
//
//   POST http://127.0.0.1:<port>/
//   x-huqan-mcp-envelope: <unpadded base64url of the envelope JSON>
//   x-huqan-client:       <the envelope's client_id, as the transport saw it>
//   body:                 one newline-free JSON-RPC message
//
// The call the envelope is verified against is the request itself:
// client_id is what the proxy declared in x-huqan-client (a signed envelope
// presented under a different client fails binding), workspace_id is the
// workspace the service was installed for, op is the JSON-RPC method, and
// args are the request's params object -- so the args digest binds the tool
// name and its arguments together.
//
// Ordering is the security property: the envelope is verified *before* the
// MCP server's gate and admission policy run and before any protected-state
// access or side effect. A refused request never reaches the handler, and its
// refusal carries the step's code and a fixed bounded message -- never the
// arguments, the signature, or key material.

const http = require('node:http');
const { recordInternalError } = require('../mcp-envelope-format');
const { refusalMessage, verifyClientEnvelope } = require('./client-envelope');
const { MCP_MAX_FRAME_BYTES, validateMcpJsonShape } = require('./stdio-transport');

const ENVELOPE_HEADER = 'x-huqan-mcp-envelope';
const CLIENT_HEADER = 'x-huqan-client';
const MAX_ENVELOPE_HEADER_BYTES = 8192;
const REFUSAL_STATUS = 403;
const METHOD_STATUS = 405;
const PAYLOAD_STATUS = 413;
const INVALID_STATUS = 400;

function refusal(res, code, status = REFUSAL_STATUS) {
  const body = JSON.stringify({ error: { code, message: refusalMessage(code) } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Build the protected loopback server around an existing MCP server.
 *
 * @param {object} options
 * @param {{handleRequest: (message: object) => object|Promise, close?: () => void}} options.server
 *   a createServer() result; its gate and admission policy stay in charge.
 * @param {Array|(() => Array)} options.enrolled enrolled client records (see
 *   client-registry), or a function returning them. A function is called for
 *   every request, so a record removed by `huqan mcp revoke` stops working on
 *   the next request without a restart.
 * @param {{consume: (nonce: string, exp: number, now: number) => boolean}} options.nonceStore
 *   the durable consumed-nonce store; required for a protected server.
 * @param {string} options.workspaceId the 16-hex workspace id the server serves.
 * @param {() => string} [options.now] injectable clock, strict UTC instant.
 * @param {(line: object) => void} [options.log] structured stderr logger.
 * @returns {import('node:http').Server}
 */
function createLoopbackMcpService({ server, enrolled, nonceStore, workspaceId, now = () => new Date().toISOString(), log = () => {} } = {}) {
  if (!server || typeof server.handleRequest !== 'function') throw new TypeError('loopback service requires an MCP server');
  if (!Array.isArray(enrolled) && typeof enrolled !== 'function') throw new TypeError('loopback service requires the enrolled-client registry');
  const currentEnrolled = () => (typeof enrolled === 'function' ? enrolled() : enrolled);
  if (!nonceStore || typeof nonceStore.consume !== 'function') throw new TypeError('loopback service requires a durable nonce store');
  if (typeof workspaceId !== 'string' || !/^[0-9a-f]{16}$/.test(workspaceId)) throw new TypeError('loopback service requires a 16-hex workspace id');

  const service = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      refusal(res, 'method_not_allowed', METHOD_STATUS);
      return;
    }
    const header = req.headers[ENVELOPE_HEADER];
    const clientHeader = req.headers[CLIENT_HEADER];
    if (typeof header !== 'string' || !header || Buffer.byteLength(header, 'utf8') > MAX_ENVELOPE_HEADER_BYTES) {
      refusal(res, 'malformed');
      return;
    }
    if (typeof clientHeader !== 'string' || !clientHeader) {
      refusal(res, 'binding_mismatch');
      return;
    }

    const chunks = [];
    let bytes = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > MCP_MAX_FRAME_BYTES) {
        // Answer once and discard the rest; destroying the socket here would
        // take the 413 away from the client before it can read it.
        refused = true;
        chunks.length = 0;
        refusal(res, 'payload_too_large', PAYLOAD_STATUS);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => { refused = true; });
    req.on('end', () => {
      if (refused) return;
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        refusal(res, 'invalid_request', INVALID_STATUS);
        return;
      }
      const shapeError = validateMcpJsonShape(message);
      if (shapeError || !message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
        refusal(res, 'invalid_request', INVALID_STATUS);
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      } catch (_) {
        envelope = null;
      }
      // The verification order is the specification's: structure, key,
      // signature, freshness, nonce, binding, arguments -- before the gate.
      const call = {
        client_id: clientHeader,
        workspace_id: workspaceId,
        op: message.method,
        args: message.params ?? {},
        now: now(),
      };
      const verdict = verifyClientEnvelope(envelope, call, currentEnrolled(), { nonceStore });
      if (!verdict.ok) {
        log({ event: 'envelope_refused', code: verdict.code, client_id: call.client_id, op: call.op });
        refusal(res, verdict.code);
        return;
      }

      let response;
      try {
        response = server.handleRequest(message);
      } catch (error) {
        const errorRef = recordInternalError('loopback/handleRequest', error);
        sendJson(res, 200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: `Internal error (ref: ${errorRef})` } });
        return;
      }
      if (response && typeof response.then === 'function') {
        response.then((settled) => {
          // A cancelled call settles to null: it answers with no body, like stdio.
          if (settled === null || settled === undefined) { res.writeHead(204); res.end(); return; }
          sendJson(res, 200, settled);
        }, (error) => {
          const errorRef = recordInternalError('loopback/handleRequest', error);
          sendJson(res, 200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: `Internal error (ref: ${errorRef})` } });
        });
        return;
      }
      if (response === null || response === undefined) { res.writeHead(204); res.end(); return; }
      sendJson(res, 200, response);
    });
  });

  // A socket that misbehaves is destroyed, not allowed to crash the process:
  // this is a long-lived service (#414's lesson, transport side).
  service.on('clientError', (error, socket) => {
    try { socket.destroy(); } catch (_) { /* the socket is already gone */ }
    void error;
  });

  return service;
}

module.exports = {
  CLIENT_HEADER,
  ENVELOPE_HEADER,
  MAX_ENVELOPE_HEADER_BYTES,
  createLoopbackMcpService,
};
