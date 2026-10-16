'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createSessionStore } = require('../lib/viewer/session-store');
const { createViewerGateway } = require('../lib/viewer/viewer-gateway');

const SENTINEL = 'viewer-ui-2-secret-key';

function invoke(gateway, pathname, method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.headers = { host: '127.0.0.1:3000' };
  req.socket = { localAddress: '127.0.0.1' };
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; },
    end(chunk = '') { this.body += chunk ? String(chunk) : ''; },
  };
  return gateway.handle(req, res, new URL(pathname, 'http://127.0.0.1:3000')).then(() => res);
}

test('V4-UI-2 serves only four exact no-store static assets', async () => {
  const gateway = createViewerGateway({
    sessionStore: createSessionStore(),
    configuredKey: () => SENTINEL,
    readReceipt: () => ({ ok: false, status: 'not_found' }),
  });
  const assets = [
    ['/viewer', 'text/html; charset=utf-8'],
    ['/viewer/app.mjs', 'text/javascript; charset=utf-8'],
    ['/viewer/receipt-view-model.mjs', 'text/javascript; charset=utf-8'],
    ['/viewer/viewer.css', 'text/css; charset=utf-8'],
  ];
  for (const [pathname, contentType] of assets) {
    const res = await invoke(gateway, pathname);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], contentType);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(res.body.includes(SENTINEL), false);
    assert.equal(Object.keys(res.headers).some((name) => name.toLowerCase().startsWith('access-control-')), false);
  }

  const html = await invoke(gateway, '/viewer');
  assert.match(html.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(html.headers['Content-Security-Policy'], /style-src 'self'/);
  assert.match(html.body, /href="\/viewer\/viewer\.css"/);
  assert.match(html.body, /src="\/viewer\/app\.mjs"/);
  assert.doesNotMatch(html.body, /<style|<script(?![^>]*type="module"[^>]*src=)/i);
});

test('V4-UI-2 rejects method, traversal, query-like path and unknown asset variants', async () => {
  const gateway = createViewerGateway({
    sessionStore: createSessionStore(),
    readReceipt: () => ({ ok: false, status: 'not_found' }),
  });
  const post = await invoke(gateway, '/viewer/app.mjs', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET');
  for (const pathname of [
    '/viewer/',
    '/viewer/index.html',
    '/viewer/app.mjs/extra',
    '/viewer/app.mjs?cache=1',
    '/viewer/%2e%2e/server.js',
    '/viewer/viewer.css.bak',
  ]) {
    const res = await invoke(gateway, pathname);
    assert.equal(res.statusCode, 404, pathname);
    assert.equal(res.body.includes(SENTINEL), false);
  }
});
