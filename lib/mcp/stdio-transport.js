'use strict';

// The MCP stdio transport: newline-delimited JSON-RPC frames on stdin, bounded
// in bytes, depth and value count, answered on stdout (#2142).

const { recordInternalError } = require('../mcp-envelope-format');

const MCP_MAX_FRAME_BYTES = 64 * 1024;
const MCP_MAX_JSON_DEPTH = 32;
const MCP_MAX_JSON_VALUES = 2048;

function validateMcpJsonShape(value) {
  const stack = [{ value, depth: 0 }];
  let values = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    values += 1;
    if (values > MCP_MAX_JSON_VALUES) return 'JSON value count exceeds protocol limit';
    if (entry.depth > MCP_MAX_JSON_DEPTH) return 'JSON nesting depth exceeds protocol limit';
    if (!entry.value || typeof entry.value !== 'object') continue;
    for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
  }
  return null;
}

/** Serve `server` (a createServer() result) over this process's stdin and stdout. */
function serveStdio(server) {
  let frame = Buffer.alloc(0);
  let discardingOversizedFrame = false;
  let shuttingDown = false;

  // Serializing the response can itself throw (a circular structure or a
  // BigInt reaching JSON.stringify), and this runs inside a stdin event
  // handler where an escaping throw is fatal. Fall back to a fixed,
  // always-serializable envelope rather than taking the process down.
  function send(msg) {
    let payload;
    try {
      payload = JSON.stringify(msg);
    } catch (err) {
      const errorRef = recordInternalError('stdio/serialize', err);
      payload = JSON.stringify({
        jsonrpc: '2.0',
        id: (msg && typeof msg === 'object' && msg.id !== undefined) ? msg.id : null,
        error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
      });
    }
    process.stdout.write(`${payload}\n`);
  }

  function sendInvalidRequest(message) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message } });
  }

  function handleFrame(buffer) {
    const trimmed = buffer.toString('utf8').trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const shapeError = validateMcpJsonShape(message);
    if (shapeError) {
      sendInvalidRequest(`Invalid Request: ${shapeError}`);
      return;
    }

    // `handleRequest` guards its own `tools/call` branch, but every other
    // branch is unguarded and this is an event handler -- an escaping throw
    // takes the whole MCP server down mid-session instead of failing the one
    // request (#414). A malformed request must never be able to do that.
    try {
      const response = server.handleRequest(message);
      if (response && typeof response.then === 'function') {
        // A cancelled call settles to null: it gets no response (#3484).
        response.then((settled) => { if (settled) send(settled); }, (err) => {
          const errorRef = recordInternalError('stdio/handleRequest', err);
          send({
            jsonrpc: '2.0', id: message.id,
            error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
          });
        });
      } else if (response) send(response);
    } catch (err) {
      const errorRef = recordInternalError('stdio/handleRequest', err);
      send({
        jsonrpc: '2.0',
        id: (message && typeof message === 'object' && message.id !== undefined) ? message.id : null,
        error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
      });
    }

    if (message && message.method === 'shutdown') {
      shuttingDown = true;
      process.stdin.pause();
      try {
        server.close();
      } catch (error) {
        recordInternalError('stdio/shutdown', error);
        process.exitCode = 1;
      }
      setTimeout(() => process.exit(process.exitCode || 0), 0).unref?.();
    }
  }

  function consume(chunk) {
    if (shuttingDown) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);

      if (discardingOversizedFrame) {
        if (newline === -1) return;
        discardingOversizedFrame = false;
        frame = Buffer.alloc(0);
      } else if (frame.length + part.length > MCP_MAX_FRAME_BYTES) {
        sendInvalidRequest(`Invalid Request: JSON-RPC frame exceeds protocol limit of ${MCP_MAX_FRAME_BYTES} bytes`);
        frame = Buffer.alloc(0);
        discardingOversizedFrame = newline === -1;
      } else {
        if (part.length > 0) frame = Buffer.concat([frame, part]);
        if (newline !== -1) {
          handleFrame(frame);
          frame = Buffer.alloc(0);
        }
      }

      if (newline === -1) return;
      offset = newline + 1;
    }
  }

  process.stdin.on('data', consume);
  process.stdin.on('end', () => {
    if (!discardingOversizedFrame && frame.length > 0) handleFrame(frame);
  });
}

module.exports = {
  MCP_MAX_FRAME_BYTES,
  MCP_MAX_JSON_DEPTH,
  MCP_MAX_JSON_VALUES,
  serveStdio,
};
