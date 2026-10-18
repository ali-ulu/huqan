'use strict';

// The per-session stdio proxy (ADR-017 §4, ADR-018 §3, #3999): the small
// helper an agent's MCP client spawns instead of the server itself. It is
// part of the untrusted agent boundary -- it holds nothing but the signing
// key the operator enrolled for its client, reads no protected state, and
// reaches the protected server only as a proxy:
//
//   stdin  -> parse one JSON-RPC frame -> sign the client envelope
//          -> POST http://127.0.0.1:<port>/ with the envelope headers
//          -> stdout <- the server's JSON-RPC answer
//
// The envelope binds one frame at a time: op is the frame's JSON-RPC method,
// args are its params, the nonce is fresh per frame, and the freshness window
// is the spec's 60 s ceiling. A frame the server refuses is relayed back as a
// JSON-RPC error that names the refusal code, so the agent sees why.
//
// The proxy only ever speaks to loopback: a --url that is not 127.0.0.1 is
// refused, because the whole point of the envelope is that loopback
// reachability is not client identity -- the proxy must not become a tunnel
// that carries signed requests to some other host.

const http = require('node:http');
const { createClientEnvelope, privateKeyFromSeed } = require('./client-envelope');
const { MCP_MAX_FRAME_BYTES } = require('./stdio-transport');

const PROXY_ERROR_ENVELOPE_REFUSED = -32001;
const PROXY_ERROR_UNREACHABLE = -32002;
const PROXY_ERROR_INVALID_REQUEST = -32600;
const CONNECT_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
const USAGE = 'usage: huqan-mcp proxy --url http://127.0.0.1:<port> --client <id> --workspace <16-hex-id> --key-file <seed-file>';

const PROXY_OPTIONS = Object.freeze(['url', 'client', 'workspace', 'key-file']);

/**
 * The proxy's options as `--name value` pairs. A real argv arrives already
 * split by the OS, so a value with spaces is one element and is taken whole;
 * a single string (tests, hand-typed) is split on whitespace outside quotes.
 */
function proxyOptionPairs(argv) {
  const tokens = Array.isArray(argv)
    ? argv.map(String)
    : [...String(argv || '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^--(.+)$/.exec(tokens[i]);
    if (!match || !PROXY_OPTIONS.includes(match[1].toLowerCase())) continue;
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    options[match[1].toLowerCase()] = value;
    i += 1;
  }
  return options;
}

function parseProxyArgs(argv) {
  const options = proxyOptionPairs(argv);
  const read = (name) => options[name] || '';
  const urlText = read('url');
  let url;
  try {
    url = new URL(urlText);
  } catch (_) {
    throw new TypeError(`proxy needs a usable --url (${USAGE})`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new TypeError('proxy refuses a non-loopback --url: it would carry signed requests off the machine');
  }
  const client = read('client');
  if (!client || Buffer.byteLength(client, 'utf8') > 512) throw new TypeError(`proxy needs --client (${USAGE})`);
  const workspaceId = read('workspace');
  if (!/^[0-9a-f]{16}$/.test(workspaceId)) throw new TypeError(`proxy needs --workspace as the pinned 16-hex id (${USAGE})`);
  const keyFile = read('key-file');
  if (!keyFile) throw new TypeError(`proxy needs --key-file (${USAGE})`);
  return { url, client, workspaceId, keyFile };
}

/**
 * The seed file holds exactly one unpadded base64url 32-byte seed. Two lines,
 * a longer key or trailing junk is refused rather than truncated.
 */
function readSigningKey(file, readFile = (name) => require('node:fs').readFileSync(name, 'utf8')) {
  const text = String(readFile(file) || '').trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) throw new TypeError('key file must hold exactly one seed line');
  return privateKeyFromSeed(lines[0]);
}

function proxyError(id, code, message) {
  return `${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`;
}

/**
 * Sign one frame and carry it to the protected server.
 *
 * @returns {Promise<{status: number, body: string|null}>}
 */
function postSigned({ url, message, envelopeHeaders }, { now = new Date() } = {}) {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...envelopeHeaders,
      },
    }, (response) => {
      let text = '';
      // Decode the stream, not each chunk: a multibyte character split across
      // two chunks must not turn into two replacement characters.
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    // Only establishing the connection is bounded. The service sends nothing
    // until the tool call settles, so an idle timeout on the open socket would
    // kill a long call (an ingest) whose side effect still completes, and a
    // client retrying after "unreachable" could repeat it.
    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => request.destroy(new Error('connect timeout')));
      socket.once('connect', () => socket.setTimeout(0));
    });
    request.on('error', reject);
    request.end(body);
    void now;
  });
}

function createFrameReader({ onData, onEnd, maxBytes = MCP_MAX_FRAME_BYTES }) {
  let frame = Buffer.alloc(0);
  let discarding = false;
  return function consume(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const part = bytes.subarray(offset, newline === -1 ? bytes.length : newline);
      if (discarding) {
        if (newline === -1) return;
        discarding = false;
        frame = Buffer.alloc(0);
      } else if (frame.length + part.length > maxBytes) {
        onData(null, `JSON-RPC frame exceeds protocol limit of ${maxBytes} bytes`);
        frame = Buffer.alloc(0);
        discarding = newline === -1;
      } else {
        if (part.length > 0) frame = Buffer.concat([frame, part]);
        if (newline !== -1) {
          onData(frame.length > 0 ? frame.toString('utf8') : '', null);
          frame = Buffer.alloc(0);
        }
      }
      if (newline === -1) return;
      offset = newline + 1;
    }
  };
}

/**
 * Run the proxy over the given stdio streams. Returns a stop function.
 *
 * @param {object} options
 * @param {string} options.url loopback endpoint from the pinned endpoint.json
 * @param {string} options.client enrolled client id
 * @param {string} options.workspaceId pinned 16-hex workspace id
 * @param {string} options.keyFile seed file the operator enrolled
 * @param {NodeJS.ReadableStream} [options.stdin] defaults to process.stdin
 * @param {NodeJS.WritableStream} [options.stdout] defaults to process.stdout
 * @param {crypto.KeyObject} [options.privateKey] overrides the key file (tests)
 */
function runProxy({ url, client, workspaceId, keyFile, stdin = process.stdin, stdout = process.stdout, privateKey } = {}) {
  const endpoint = typeof url === 'string' ? new URL(url) : url;
  const key = privateKey ?? readSigningKey(keyFile);
  let stopped = false;

  async function relay(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      stdout.write(proxyError(null, PROXY_ERROR_INVALID_REQUEST, 'Parse error'));
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      stdout.write(proxyError(message?.id ?? null, PROXY_ERROR_INVALID_REQUEST, 'Invalid Request: missing method'));
      return;
    }
    // The envelope rejects an empty or oversized method: answer that frame
    // with an error instead of letting the throw end the whole session.
    let envelope;
    try {
      envelope = createClientEnvelope({
        client_id: client,
        workspace_id: workspaceId,
        op: message.method,
        args: message.params ?? {},
        now: new Date(),
      }, key);
    } catch (_) {
      stdout.write(proxyError(message.id, PROXY_ERROR_INVALID_REQUEST, 'Invalid Request: the frame cannot be signed'));
      return;
    }
    const headers = {
      'x-huqan-mcp-envelope': Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url'),
      'x-huqan-client': client,
    };
    let answer;
    try {
      answer = await postSigned({ url: endpoint, message, envelopeHeaders: headers });
    } catch (_) {
      stdout.write(proxyError(message.id, PROXY_ERROR_UNREACHABLE, 'the protected MCP service is unreachable'));
      return;
    }
    if (answer.status === 200) {
      if (answer.body && answer.body.length) stdout.write(`${answer.body}\n`);
      return;
    }
    if (answer.status === 204) return;
    let code = 'refused';
    try {
      const parsed = JSON.parse(answer.body || '');
      code = parsed?.error?.code || code;
    } catch (_) { /* keep the generic code; never echo the body */ }
    stdout.write(proxyError(message.id, PROXY_ERROR_ENVELOPE_REFUSED, `the envelope was refused (${code})`));
  }

  const consume = createFrameReader({
    onData: (text, error) => {
      if (stopped) return;
      if (error) { stdout.write(proxyError(null, PROXY_ERROR_INVALID_REQUEST, `Invalid Request: ${error}`)); return; }
      void relay(text);
    },
  });
  stdin.on('data', consume);
  stdin.on('end', () => { stopped = true; });
  return () => { stopped = true; };
}

module.exports = {
  LOOPBACK_HOSTS,
  PROXY_ERROR_ENVELOPE_REFUSED,
  PROXY_ERROR_INVALID_REQUEST,
  PROXY_ERROR_UNREACHABLE,
  USAGE,
  createFrameReader,
  parseProxyArgs,
  postSigned,
  readSigningKey,
  runProxy,
};
