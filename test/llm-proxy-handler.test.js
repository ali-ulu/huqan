'use strict';

/**
 * Transparent LLM proxy (#1908).
 *
 * Locks in: byte-verbatim passthrough, OpenAI-shaped errors, fail-closed
 * limits (413/502/stream-400), missing-key 401, ledger-failure tolerance,
 * and authenticated-only policy declaration.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  parseLlmProxyPath,
  createLlmProxyHandler,
  MAX_REQUEST_BYTES,
} = require('../lib/llm-proxy/proxy-handler');
const { resolveProxyConfig, DEFAULT_UPSTREAM } = require('../lib/llm-proxy/proxy-config');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

const CONFIG = Object.freeze({ upstream: 'https://upstream.test', timeoutMs: 5000, apiKey: 'server-key' });

function stubReq({ method = 'POST', body = '', headers = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function stubRes(captured) {
  return {
    writeHead: (status, headers) => { captured.status = status; captured.headers = headers; },
    end: (body) => { captured.body = String(body); },
  };
}

function stubWriteJson(captured) {
  return (req, res, status, body, headers) => {
    captured.status = status;
    captured.headers = headers || {};
    captured.body = JSON.stringify(body);
  };
}

function stubUpstream({ status = 200, body = '{"id":"x","usage":{"prompt_tokens":1,"completion_tokens":2}}' } = {}) {
  const seen = {};
  const fetchImpl = async (url, options) => {
    seen.url = url;
    seen.options = options;
    return {
      status,
      headers: { get: () => 'application/json' },
      text: async () => body,
    };
  };
  return { seen, fetchImpl };
}

const NULL_GRAPH = Object.freeze({});

test('proxy path parsing routes chat, models and method mismatches', () => {
  assert.equal(parseLlmProxyPath('/v1/chat/completions', 'POST'), 'chat-completions');
  assert.equal(parseLlmProxyPath('/v1/chat/completions', 'GET'), 'method-mismatch');
  assert.equal(parseLlmProxyPath('/v1/models', 'GET'), 'models');
  assert.equal(parseLlmProxyPath('/v1/models', 'POST'), 'method-mismatch');
  assert.equal(parseLlmProxyPath('/api/audit', 'GET'), null);
  assert.equal(parseLlmProxyPath('/verify', 'POST'), null);
});

test('chat completions pass through verbatim and forward auth', async () => {
  const { seen, fetchImpl } = stubUpstream();
  const { handleLlmProxy } = createLlmProxyHandler({ graph: NULL_GRAPH, writeJson: stubWriteJson({}), fetchImpl, config: CONFIG });
  const rawBody = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  const captured = {};
  const handled = await handleLlmProxy(stubReq({ body: rawBody }), stubRes(captured), { pathname: '/v1/chat/completions' });
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.equal(captured.body, '{"id":"x","usage":{"prompt_tokens":1,"completion_tokens":2}}');
  assert.equal(seen.url, 'https://upstream.test/v1/chat/completions');
  assert.equal(String(seen.options.body), rawBody);
  assert.equal(seen.options.headers.Authorization, 'Bearer server-key');
});

test('client auth is forwarded when no server key is configured', async () => {
  const { seen, fetchImpl } = stubUpstream();
  const noKey = { ...CONFIG, apiKey: '' };
  const { handleLlmProxy } = createLlmProxyHandler({ graph: NULL_GRAPH, writeJson: stubWriteJson({}), fetchImpl, config: noKey });
  const captured = {};
  await handleLlmProxy(
    stubReq({ body: '{}', headers: { authorization: 'Bearer client-key' } }),
    stubRes(captured),
    { pathname: '/v1/chat/completions' },
  );
  assert.equal(seen.options.headers.Authorization, 'Bearer client-key');
  assert.equal(captured.status, 200);
});

test('missing key answers 401 without contacting upstream', async () => {
  let called = false;
  const noKey = { ...CONFIG, apiKey: '' };
  const { handleLlmProxy } = createLlmProxyHandler({
    graph: NULL_GRAPH, writeJson: stubWriteJson({}), fetchImpl: async () => { called = true; throw new Error('must not call'); }, config: noKey,
  });
  const captured = {};
  const writeJson = stubWriteJson(captured);
  const { handleLlmProxy: h2 } = createLlmProxyHandler({ graph: NULL_GRAPH, writeJson, fetchImpl: async () => { called = true; }, config: noKey });
  await h2(stubReq({ body: '{}' }), stubRes({}), { pathname: '/v1/chat/completions' });
  assert.equal(called, false);
  assert.equal(captured.status, 401);
  assert.ok(handleLlmProxy);
});

test('invalid json, stream flag and oversize bodies are refused', async () => {
  const { fetchImpl } = stubUpstream();
  const captured = {};
  const { handleLlmProxy } = createLlmProxyHandler({ graph: NULL_GRAPH, writeJson: stubWriteJson(captured), fetchImpl, config: CONFIG });

  await handleLlmProxy(stubReq({ body: 'not-json' }), stubRes({}), { pathname: '/v1/chat/completions' });
  assert.equal(captured.status, 400);

  await handleLlmProxy(stubReq({ body: JSON.stringify({ model: 'm', stream: true }) }), stubRes({}), { pathname: '/v1/chat/completions' });
  assert.equal(captured.status, 400);

  const big = `{"model":"m","messages":[{"role":"user","content":"${'x'.repeat(MAX_REQUEST_BYTES)}"}]}`;
  assert.ok(big.length > MAX_REQUEST_BYTES);
  await handleLlmProxy(stubReq({ body: big }), stubRes({}), { pathname: '/v1/chat/completions' });
  assert.equal(captured.status, 413);
});

test('upstream failure becomes a 502, ledger failure never breaks passthrough', async () => {
  const captured = {};
  const { handleLlmProxy: failing } = createLlmProxyHandler({
    graph: NULL_GRAPH,
    writeJson: stubWriteJson(captured),
    fetchImpl: async () => { throw new Error('boom'); },
    config: CONFIG,
  });
  await failing(stubReq({ body: '{}' }), stubRes({}), { pathname: '/v1/chat/completions' });
  assert.equal(captured.status, 502);

  const explodingGraph = {
    runMutationOnce: () => { throw new Error('ledger down'); },
    getCommittedMutationReceiptByOperation: () => null,
    getCommittedMutationReceiptById: () => null,
  };
  const { seen, fetchImpl } = stubUpstream();
  const ok = {};
  const { handleLlmProxy: resilient } = createLlmProxyHandler({
    graph: explodingGraph, writeJson: stubWriteJson({}), fetchImpl, config: CONFIG,
  });
  const handled = await resilient(stubReq({ body: '{}' }), stubRes(ok), { pathname: '/v1/chat/completions' });
  assert.equal(handled, true);
  assert.equal(ok.status, 200);
  assert.ok(seen.url);
});

test('models list passes through', async () => {
  const { fetchImpl } = stubUpstream({ body: '{"data":[]}' });
  const { handleLlmProxy } = createLlmProxyHandler({ graph: NULL_GRAPH, writeJson: stubWriteJson({}), fetchImpl, config: CONFIG });
  const captured = {};
  const handled = await handleLlmProxy(stubReq({ method: 'GET', body: '' }), stubRes(captured), { pathname: '/v1/models' });
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.equal(captured.body, '{"data":[]}');
});

test('proxy routes are authenticated in the central policy', () => {
  for (const pathname of ['/v1/chat/completions', '/v1/models']) {
    const decision = resolveRouteAuthPolicy(pathname, pathname === '/v1/models' ? 'GET' : 'POST');
    assert.equal(decision.known, true, `${pathname} declared`);
    assert.equal(decision.authRequired, true, `${pathname} requires auth (no open relay)`);
  }
});

test('proxy config reads HUQAN names with safe defaults', () => {
  const empty = resolveProxyConfig({});
  assert.equal(empty.upstream, DEFAULT_UPSTREAM);
  assert.equal(empty.apiKey, '');
  const full = resolveProxyConfig({ HUQAN_LLM_PROXY_UPSTREAM: 'https://o.test/', HUQAN_LLM_PROXY_API_KEY: 'k', HUQAN_LLM_PROXY_TIMEOUT_MS: '5000' });
  assert.equal(full.upstream, 'https://o.test');
  assert.equal(full.apiKey, 'k');
  assert.equal(full.timeoutMs, 5000);
  const clamped = resolveProxyConfig({ HUQAN_LLM_PROXY_TIMEOUT_MS: '99999999' });
  assert.ok(clamped.timeoutMs <= 300000);
});
