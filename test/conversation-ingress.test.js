'use strict';

/**
 * COG-C (#4393, PR-3): the ingress adapter over the existing surfaces.
 *
 * The plan asks for a thin adapter between `lib/http/answer-route.js` and
 * `lib/llm-proxy/proxy-handler.js` and the workspace-bound conversation
 * service, without changing what those surfaces already answer. So these tests
 * pin both halves: the existing response is byte-for-byte unchanged, and the
 * turn the surface served is recorded through the same store the conversation
 * route uses.
 *
 * `lib/conversation-ingress.js` is Core, so it never imports the admission
 * gate; the caller injects it. The test injects the real gate, not a stub, so
 * an unadmitted turn is exercised through the same decision the product makes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const Graph = require('../graph');
const { recordIngressTurn, buildConversationAdmissionRequest } = require('../lib/conversation-ingress');
const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');
const { readConversationHistory } = require('../lib/conversation-store');
const { createAnswerRoute } = require('../lib/http/answer-route');
const { createLlmProxyHandler } = require('../lib/llm-proxy/proxy-handler');
const { createServerRequestHandler } = require('../lib/http/server-request-handler');
const { createCoreHttpRoutes } = require('../lib/http/core-http-routes');

const WORKSPACE = 'ws_a';
const CONVERSATION = 'c_1';
const MESSAGE = 'm_1';
const SEQUENCE = 1;

function graphIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ingress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const record = (graph, overrides = {}) => recordIngressTurn({
  graph,
  evaluateAdmission: evaluateMemoryAdmission,
  workspaceId: WORKSPACE,
  conversationId: CONVERSATION,
  sessionId: 's_1',
  messageId: MESSAGE,
  sequence: SEQUENCE,
  content: 'hello there',
  ...overrides,
});

const history = (graph, extra = {}) => readConversationHistory(graph, {
  workspaceId: WORKSPACE, conversationId: CONVERSATION, ...extra,
});

test('a complete turn is recorded, digest-only, and its retry replays', (t) => {
  const graph = graphIn(t);

  const first = record(graph);
  assert.equal(first.recorded, true);
  assert.equal(first.replayed, false);
  assert.ok(first.admissionId, 'the admitted turn carries its admission id');

  const rows = history(graph);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, MESSAGE);
  assert.equal(rows[0].contentChars, 'hello there'.length);
  assert.equal(rows[0].workspaceId, WORKSPACE);
  // Invariant 9: the body never reaches the journal, only its digest.
  assert.equal(Object.hasOwn(rows[0], 'content'), false);
  assert.match(rows[0].contentDigest, /^[0-9a-f]{64}$/);

  const retry = record(graph);
  assert.equal(retry.recorded, false);
  assert.equal(retry.replayed, true);
  assert.equal(history(graph).length, 1, 'a retry is not a second row');
});

test('an incomplete identity records nothing, so an ordinary caller is unaffected', (t) => {
  const graph = graphIn(t);

  for (const missing of ['workspaceId', 'conversationId', 'sessionId', 'messageId']) {
    const result = record(graph, { [missing]: undefined });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'identity_incomplete');
  }
  // A sequence is required rather than derived: a derived value would differ
  // between a first attempt and a retry, turning a replay into a conflict.
  assert.equal(record(graph, { sequence: undefined }).reason, 'identity_incomplete');
  assert.equal(record(graph, { sequence: 'nope' }).reason, 'identity_incomplete');
  // A null argument must not reach the destructuring: the contract is no throw.
  assert.equal(recordIngressTurn(null).reason, 'identity_incomplete');
  assert.equal(recordIngressTurn().reason, 'identity_incomplete');
  assert.equal(record(graph, { content: '   ' }).reason, 'empty_content');
  assert.equal(record(graph, { content: 'x'.repeat(100001) }).reason, 'content_too_long');

  assert.deepEqual(history(graph), []);
});

test('an unadmitted turn never becomes context', (t) => {
  const graph = graphIn(t);

  const result = recordIngressTurn({
    graph,
    // A gate that answers anything but `allow` stands in for a review,
    // quarantine or reject decision.
    evaluateAdmission: () => ({ ok: true, decision: { decision: 'quarantine', admissionId: 'a_1' } }),
    workspaceId: WORKSPACE,
    conversationId: CONVERSATION,
    sessionId: 's_1',
    messageId: MESSAGE,
    sequence: SEQUENCE,
    content: 'hello there',
  });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'not_admitted');
  assert.equal(result.decision, 'quarantine');
  assert.deepEqual(history(graph), []);
});

test('a journal outage or a conflicting retry degrades to a reason, never a throw', (t) => {
  const graph = graphIn(t);
  assert.equal(record(graph).recorded, true);

  // A different payload for the same messageId is the store's conflict.
  const conflict = record(graph, { content: 'a different body' });
  assert.equal(conflict.recorded, false);
  assert.equal(conflict.reason, 'conflict');

  // A graph whose prefix read throws is an outage, not a conflict.
  const broken = { runMutationOnce: () => {}, getCommittedMutationResultsByPrefix: () => { throw new Error('down'); } };
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const outage = recordIngressTurn({
      graph: broken,
      evaluateAdmission: evaluateMemoryAdmission,
      workspaceId: WORKSPACE,
      conversationId: CONVERSATION,
      sessionId: 's_1',
      messageId: 'm_2',
      sequence: 2,
      content: 'hello there',
    });
    assert.equal(outage.recorded, false);
    assert.equal(outage.reason, 'store_unavailable');
  } finally {
    console.error = originalError;
  }
  // The caller discards the return value, so the log is the only trace an
  // unrecorded turn leaves.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /store_unavailable/);
});

test('another workspace never sees the turn', (t) => {
  const graph = graphIn(t);
  record(graph);

  assert.equal(history(graph, { workspaceId: 'ws_b' }).length, 0);
  assert.equal(history(graph, { conversationId: 'c_2' }).length, 0);
});

test('the shared admission request is one shape for both callers', () => {
  const request = buildConversationAdmissionRequest({ workspaceId: WORKSPACE, messageId: MESSAGE });
  assert.equal(request.workspaceId, WORKSPACE);
  assert.equal(request.memoryDraftId, MESSAGE);
  assert.equal(request.provenanceId, MESSAGE);
  assert.equal(request.actor, 'user');
  // The same request reaches the real gate for a verdict, not just a shape.
  assert.equal(evaluateMemoryAdmission(request).decision.decision, 'allow');
});

/* ------------------------------------------------------------------ */
/* The two existing surfaces keep their response and gain the capture. */
/* ------------------------------------------------------------------ */

function answerReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '198.51.100.7' },
    on(event, handler) {
      if (event === 'data') chunks.forEach((chunk) => handler(chunk));
      if (event === 'end') handler();
      return this;
    },
  };
}

function captureRes() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; };
  res.end = (body) => { res.body = body; };
  return res;
}

function answerDeps({ graph, recordConversationTurn }) {
  return {
    kernel: { verify: () => ({ evidence: [] }), graph },
    legacyVerify: (value) => value,
    sanitizeInput: (value) => (typeof value === 'string' ? value.trim() : ''),
    parseJsonRequest: async (req) => new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
    }),
    denyIfUnauthorized: () => true,
    buildCorsHeaders: () => ({}),
    JSON_CONTENT_TYPE: 'application/json',
    DEFAULT_MAX_JSON_BODY: 262144,
    writeJson: (req, res, status, payload) => { res.writeHead(status, {}); res.end(JSON.stringify(payload)); },
    emergencyStop: null,
    recordConversationTurn,
  };
}

test('/answer serves the same response and records the turn it answered', async (t) => {
  const graph = graphIn(t);
  const handle = createAnswerRoute(answerDeps({
    graph,
    recordConversationTurn: (turn) => recordIngressTurn({ graph, evaluateAdmission: evaluateMemoryAdmission, ...turn }),
  }));

  const res = captureRes();
  await handle(answerReq({
    question: 'what is a graph?',
    workspaceId: WORKSPACE,
    conversationId: CONVERSATION,
    sessionId: 's_1',
    messageId: MESSAGE,
    sequence: SEQUENCE,
  }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  // The response shape the surface already had is unchanged: the capture adds
  // no field and removes none.
  assert.deepEqual(Object.keys(payload).sort(), ['answer', 'confidence', 'evidenceCount', 'lang', 'ok', 'question', 'status'].sort());

  const rows = history(graph);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentChars, 'what is a graph?'.length);
  assert.equal(Object.hasOwn(rows[0], 'content'), false);
});

test('/answer without a conversation identity answers as before and records nothing', async (t) => {
  const graph = graphIn(t);
  const handle = createAnswerRoute(answerDeps({
    graph,
    recordConversationTurn: (turn) => recordIngressTurn({ graph, evaluateAdmission: evaluateMemoryAdmission, ...turn }),
  }));

  const res = captureRes();
  await handle(answerReq({ question: 'what is a graph?', workspaceId: WORKSPACE }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(history(graph), []);
});

test('/answer without a recorder at all still serves, and records nothing', async (t) => {
  const graph = graphIn(t);
  // No `recordConversationTurn` in the deps: the capture is opt-in, so the
  // surface the answer route already had must keep working.
  const handle = createAnswerRoute(answerDeps({ graph }));

  const res = captureRes();
  await handle(answerReq({
    question: 'what is a graph?',
    workspaceId: WORKSPACE,
    conversationId: CONVERSATION,
    sessionId: 's_1',
    messageId: MESSAGE,
    sequence: SEQUENCE,
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.deepEqual(history(graph), []);
});

test('a recorder that throws never changes the answer the caller already served', async (t) => {
  const graph = graphIn(t);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const handle = createAnswerRoute(answerDeps({
      graph,
      recordConversationTurn: () => { throw new Error('capture exploded'); },
    }));

    const res = captureRes();
    await handle(answerReq({
      question: 'what is a graph?',
      workspaceId: WORKSPACE,
      conversationId: CONVERSATION,
      sessionId: 's_1',
      messageId: MESSAGE,
      sequence: SEQUENCE,
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /capture exploded/);
});

/* ------------------------------------------------------------------ */
/* The proxy stays byte-verbatim and captures from headers only.        */
/* ------------------------------------------------------------------ */

function proxyReq({ body, headers = {} }) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', authorization: 'Bearer client-key', ...headers };
  process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}

function proxyRes() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; };
  res.end = (body) => { res.body = String(body); };
  return res;
}

const UPSTREAM_BODY = '{"id":"x","choices":[]}';
const upstreamOk = async () => ({
  status: 200,
  headers: { get: () => 'application/json' },
  text: async () => UPSTREAM_BODY,
});

test('the proxy stays byte-verbatim and records a header-declared turn', async (t) => {
  const graph = graphIn(t);
  const body = JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi proxy' }] });
  const handler = createLlmProxyHandler({
    graph,
    writeJson: () => {},
    fetchImpl: upstreamOk,
    config: { upstream: 'https://upstream.test', timeoutMs: 5000, apiKey: 'server-key' },
    recordConversationTurn: (turn) => recordIngressTurn({ graph, evaluateAdmission: evaluateMemoryAdmission, ...turn }),
  });

  const res = proxyRes();
  await handler.handleLlmProxy(proxyReq({
    body,
    headers: {
      'x-huqan-workspace': WORKSPACE,
      'x-huqan-conversation': CONVERSATION,
      'x-huqan-session': 's_1',
      'x-huqan-message': MESSAGE,
      'x-huqan-sequence': String(SEQUENCE),
    },
  }), res, { pathname: '/v1/chat/completions' });

  // The upstream answer is returned verbatim, unmodified by the capture.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, UPSTREAM_BODY);

  const rows = history(graph);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentChars, 'hi proxy'.length);
  assert.equal(Object.hasOwn(rows[0], 'content'), false);
});

test('the proxy records nothing without the headers, and its response is unchanged', async (t) => {
  const graph = graphIn(t);
  const body = JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi proxy' }] });
  const handler = createLlmProxyHandler({
    graph,
    writeJson: () => {},
    fetchImpl: upstreamOk,
    config: { upstream: 'https://upstream.test', timeoutMs: 5000, apiKey: 'server-key' },
    recordConversationTurn: (turn) => recordIngressTurn({ graph, evaluateAdmission: evaluateMemoryAdmission, ...turn }),
  });

  const res = proxyRes();
  await handler.handleLlmProxy(proxyReq({ body }), res, { pathname: '/v1/chat/completions' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, UPSTREAM_BODY);
  assert.deepEqual(history(graph), []);
});

test('a proxy without a recorder still passes through, unchanged', async (t) => {
  const graph = graphIn(t);
  const body = JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi proxy' }] });
  const handler = createLlmProxyHandler({
    graph,
    writeJson: () => {},
    fetchImpl: upstreamOk,
    config: { upstream: 'https://upstream.test', timeoutMs: 5000, apiKey: 'server-key' },
  });

  const res = proxyRes();
  await handler.handleLlmProxy(proxyReq({
    body,
    headers: { 'x-huqan-workspace': WORKSPACE, 'x-huqan-conversation': CONVERSATION, 'x-huqan-message': MESSAGE, 'x-huqan-sequence': '1' },
  }), res, { pathname: '/v1/chat/completions' });

  assert.equal(res.body, UPSTREAM_BODY);
  assert.deepEqual(history(graph), []);
});

/* ------------------------------------------------------------------ */
/* The real dispatcher: the wiring production uses, not the route alone.*/
/* ------------------------------------------------------------------ */

const notHandled = async () => false;

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; };
  res.end = (body) => { res.body = body; };
  res.setHeader = () => {};
  res.headersSent = false;
  res.on = () => {};
  res.once = () => {};
  return res;
}

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '198.51.100.7' },
    on(event, handler) {
      if (event === 'data') chunks.forEach((chunk) => handler(chunk));
      if (event === 'end') handler();
      return this;
    },
  };
}

/** The production handler: the answer route is wired exactly as server.js does. */
function dispatcher({ graph }) {
  const kernel = { graph, verify: () => ({ evidence: [] }) };
  const parseJsonRequest = async (req, res, options = {}) => {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
    });
    if (!raw) { res.writeHead(400, {}); res.end('{"ok":false}'); return null; }
    try { return JSON.parse(raw); } catch { res.writeHead(400, {}); res.end('{"ok":false}'); return null; }
  };
  const writeJson = (req, res, status, payload, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
  const writeApiError = (req, res, status, code, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code, message }));
  };
  const handleAnswerRoute = createAnswerRoute({
    kernel,
    legacyVerify: (value) => value,
    sanitizeInput: (value) => (typeof value === 'string' ? value.trim() : ''),
    parseJsonRequest,
    denyIfUnauthorized: () => true,
    buildCorsHeaders: () => ({}),
    JSON_CONTENT_TYPE: 'application/json',
    DEFAULT_MAX_JSON_BODY: 262144,
    writeJson,
    emergencyStop: null,
    recordConversationTurn: (turn) => recordIngressTurn({ graph, evaluateAdmission: evaluateMemoryAdmission, ...turn }),
  });
  const core = createCoreHttpRoutes({
    kernel,
    getGraphData: () => ({ nodes: {}, edges: {} }),
    getV2StatusData: () => ({}),
    getHealthData: () => ({}),
    handleAnswerRoute,
    parseJsonRequest,
    denyIfUnauthorized: () => true,
    buildCorsHeaders: () => ({}),
    writeJson,
    writeApiError,
    legacyVerify: () => {},
    JSON_CONTENT_TYPE: 'application/json',
    emergencyStop: null,
  });
  return createServerRequestHandler({
    kernel,
    concurrencyLimiter: { tryAcquire: () => true, release: () => {} },
    denyIfUnauthorized: () => true,
    viewerMount: { isViewerPath: () => false, checkRateLimit: () => true, handle: async () => {} },
    externalClientBoundary: null,
    optionalRoutes: { authContext: {}, route: notHandled },
    handleObservabilityRoute: notHandled,
    handleV5PackageImportRoute: notHandled,
    handleV5PreflightRoute: notHandled,
    handleReadWorkflow: notHandled,
    handleWorkflowDataRoute: notHandled,
    handleFitnessDashboardRoute: notHandled,
    handleCoreRoutes: core,
    handleIngestHttpRoutes: notHandled,
    handleReceiptReadRoute: () => false,
    handleWorkbenchRead: () => false,
    handleTrustQueryRoutes: () => false,
    handlePublicApiRoute: notHandled,
  });
}

test('through the real dispatcher, /answer serves and the turn becomes context', async (t) => {
  const graph = graphIn(t);
  const handler = dispatcher({ graph });

  const res = makeRes();
  await handler(makeReq('POST', '/answer', {
    question: 'what is a graph?',
    workspaceId: WORKSPACE,
    conversationId: CONVERSATION,
    sessionId: 's_1',
    messageId: MESSAGE,
    sequence: SEQUENCE,
  }), res);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.question, 'what is a graph?');

  // The captured turn is what the conversation surface then plans against: the
  // same store, read through its own public contract.
  const rows = history(graph);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentChars, 'what is a graph?'.length);
  assert.equal(Object.hasOwn(rows[0], 'content'), false);
});
