'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { createSessionStore } = require('../lib/viewer/session-store');
const { createViewerGateway } = require('../lib/viewer/viewer-gateway');

const SENTINEL = 'v4-ui-0b-sentinel-key-DO-NOT-LEAK';

function request({ method, path: requestPath, headers, body = '' }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = requestPath;
  req.headers = headers;
  req.socket = { localAddress: '127.0.0.1' };
  return req;
}

async function invoke(gateway, options) {
  const req = request(options);
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; },
    end(chunk = '') { this.body += chunk ? String(chunk) : ''; },
  };
  await gateway.handle(req, res, new URL(options.path, `http://${options.headers.host}`));
  return res;
}

function allPublicFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) result.push(...allPublicFiles(entry));
    else result.push(entry);
  }
  return result;
}

function assertNoKey(value) {
  assert.equal(JSON.stringify(value).includes(SENTINEL), false);
}

test('V4-UI-0B never exposes the operator API key', async () => {
  const store = createSessionStore();
  const gateway = createViewerGateway({
    sessionStore: store,
    configuredKey: () => SENTINEL,
    allowInsecureLoopback: () => true,
    readReceipt: () => ({
      ok: true,
      receipt: { receiptId: 'receipt-1', verdict: 'ALLOW', reason: 'verified' },
    }),
  });
  const baseHeaders = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };

  const captured = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => captured.push(args);
  console.error = (...args) => captured.push(args);
  console.warn = (...args) => captured.push(args);
  try {
    const wrong = await invoke(gateway, {
      method: 'POST', path: '/viewer/session', headers: baseHeaders, body: JSON.stringify({ apiKey: `${SENTINEL}-wrong` }),
    });
    const login = await invoke(gateway, {
      method: 'POST', path: '/viewer/session', headers: baseHeaders, body: JSON.stringify({ apiKey: SENTINEL }),
    });
    const cookie = String(login.headers['Set-Cookie']).split(';', 1)[0];
    const token = cookie.split('=', 2)[1];
    const read = await invoke(gateway, {
      method: 'GET', path: '/viewer/api/trust-receipt/receipt-1', headers: { host: baseHeaders.host, cookie },
    });
    const logout = await invoke(gateway, {
      method: 'DELETE', path: '/viewer/session', headers: { ...baseHeaders, cookie },
    });

    assert.equal(wrong.statusCode, 401);
    assert.equal(login.statusCode, 200);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(token, SENTINEL);
    assert.equal(read.statusCode, 200);
    assert.equal(logout.statusCode, 204);
    for (const value of [wrong, login, read, logout, captured]) assertNoKey(value);
    assert.deepEqual(Object.keys(JSON.parse(read.body).receipt).some((key) => /api.?key|authorization/i.test(key)), false);
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }

  const publicRoot = path.join(__dirname, '..', 'public');
  for (const file of allPublicFiles(publicRoot)) {
    assert.equal(readFileSync(file).includes(SENTINEL), false, `key leaked into ${file}`);
  }
});
