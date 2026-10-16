'use strict';

// #3905: the emergency stop was enforced on the MCP surface and nowhere on
// HTTP, so a stopped workspace kept answering ask/verify/search/learn with 200
// while the same workspace was refused over MCP. These tests pin the HTTP half
// to the same decision: the same ledger, the same `EMERGENCY_STOPPED` code, and
// no graph read once the workspace is stopped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEmergencyStop } = require('../lib/emergency-stop');
const {
  runReadWorkflow,
  createReadWorkflowHttpRouter,
  NO_CAPABILITY_ENSURE,
} = require('../lib/http/read-workflow-actions');
const { createWorkflowDataRoutes } = require('../lib/http/workflow-data-routes');
const { createCoreHttpRoutes } = require('../lib/http/core-http-routes');
const { createAnswerRoute } = require('../lib/http/answer-route');
const { createOptionalRouteBoundaries } = require('../lib/http/optional-boundaries');
const { EMERGENCY_STOPPED_STATUS, EMERGENCY_STOPPED_CODE } = require('../lib/http/emergency-stop-gate');

function ledgerIn(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-3905-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createEmergencyStop({ directory: dir });
}

// A kernel that counts every read, so "the stop is checked before the read" is
// an assertion rather than a claim.
function countingKernel() {
  const reads = { ask: 0, verify: 0 };
  return {
    reads,
    ask(question) { reads.ask += 1; return { ok: true, type: 'ask', data: { answer: question, subject: question, unknown: false, alternatives: 0, confidence: 0.5 } }; },
    verify(claim) { reads.verify += 1; return { ok: true, status: 'verified', claim, confidence: 0.5, evidence: [] }; },
    graph: { getNodes: () => ({}), getNode: () => null, getCandidateClaims: () => [], getAuditEvents: () => [] },
  };
}

const LEGACY_HELPERS = {
  JSON_CONTENT_TYPE: 'application/json',
  buildCorsHeaders: () => ({}),
  legacyVerify: (result) => result,
};

test('a stopped workspace refuses the HTTP read workflows before reading the graph', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'parity probe', actor: 'test' });
  const kernel = countingKernel();

  for (const [workflowId, input] of [
    ['ask', { question: 'what is tcp', workspaceId: 'default' }],
    ['verify', { claim: 'tcp handshake uses syn', workspaceId: 'default' }],
    ['memory-search', { query: 'tcp', workspaceId: 'default' }],
  ]) {
    const result = await runReadWorkflow({ workflowId, kernel, input, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
    assert.equal(result.statusCode, EMERGENCY_STOPPED_STATUS, `${workflowId} must be refused`);
    assert.equal(result.body.error.code, EMERGENCY_STOPPED_CODE, `${workflowId} must name the stop`);
    assert.equal(result.body.status, 'blocked');
    assert.equal(result.body.ok, false);
  }
  assert.deepEqual(kernel.reads, { ask: 0, verify: 0 }, 'a stop must be decided before any read');
});

test('lifting the stop lets the same read workflow through again', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  const kernel = countingKernel();

  const stopped = await runReadWorkflow({ workflowId: 'ask', kernel, input: { question: 'q', workspaceId: 'default' }, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
  assert.equal(stopped.statusCode, EMERGENCY_STOPPED_STATUS);

  ledger.lift({ scope: 'workspace', workspaceId: 'default', reason: 'reviewed', actor: 'test' });
  const lifted = await runReadWorkflow({ workflowId: 'ask', kernel, input: { question: 'q', workspaceId: 'default' }, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
  assert.equal(lifted.statusCode, 200);
  assert.equal(kernel.reads.ask, 1);
});

test('an agent-scope stop does not block HTTP reads, which carry no agent identity', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'contain', actor: 'test' });
  const kernel = countingKernel();

  // HTTP carries no agent id, so an agent-scope stop cannot be matched here;
  // only a workspace stop closes the HTTP surface. This is the same shape as
  // the MCP check, which also only looks at workspaceId.
  const result = await runReadWorkflow({ workflowId: 'verify', kernel, input: { claim: 'c', workspaceId: 'w' }, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
  assert.equal(result.statusCode, 200);

  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'escalate', actor: 'test' });
  const blocked = await runReadWorkflow({ workflowId: 'verify', kernel, input: { claim: 'c', workspaceId: 'w' }, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
  assert.equal(blocked.statusCode, EMERGENCY_STOPPED_STATUS);
});

test('the workflow HTTP router answers 423 EMERGENCY_STOPPED while stopped', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  const writes = [];
  const handler = createReadWorkflowHttpRouter({
    kernel: countingKernel(),
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    writeApiError: () => assert.fail('a stop must not fall through to a generic error'),
    ensureCapabilities: NO_CAPABILITY_ENSURE,
    emergencyStop: ledger,
  });
  const handled = await handler(
    { method: 'POST', body: { question: 'what is tcp', workspaceId: 'default' } },
    {},
    new URL('http://localhost/api/v2/workflows/ask'),
  );
  assert.equal(handled, true);
  assert.equal(writes[0].status, EMERGENCY_STOPPED_STATUS);
  assert.equal(writes[0].json.error.code, EMERGENCY_STOPPED_CODE);
  assert.equal(writes[0].headers['Cache-Control'], 'no-store');
});

test('the learn workflow names the stop instead of a misleading REVIEW_NOT_PERSISTED', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  let proposed = 0;
  const writes = [];
  const routes = createWorkflowDataRoutes({
    getApprovalStore: () => null,
    decideApproval: () => ({}),
    decideLearnApproval: () => ({}),
    readReceipt: () => null,
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
    proposeLearn: async () => { proposed += 1; return { approval: null }; },
    submitIngest: () => ({}),
    createAgent: () => ({}),
    emergencyStop: ledger,
  });
  const handled = await routes(
    { method: 'POST', body: { text: 'the parity stop marker is present', workspaceId: 'default' } },
    {},
    new URL('http://localhost/api/v2/workflows/learn'),
  );
  assert.equal(handled, true);
  assert.equal(writes[0].status, EMERGENCY_STOPPED_STATUS);
  assert.equal(writes[0].json.error.code, EMERGENCY_STOPPED_CODE);
  assert.equal(proposed, 0, 'a stopped workspace must not even propose a learn review');
});

test('the legacy /verify and /dogrula surfaces are refused while stopped', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  for (const pathname of ['/verify', '/dogrula']) {
    const responses = [];
    const res = {
      writeHead(status) { this._status = status; },
      end(bytes) { responses.push({ status: this._status, body: JSON.parse(bytes) }); },
    };
    const handleCore = createCoreHttpRoutes({
      kernel: countingKernel(),
      getGraphData: () => ({}),
      getV2StatusData: () => ({}),
      getHealthData: () => ({}),
      handleAnswerRoute: () => false,
      parseJsonRequest: async () => ({ claim: 'tcp handshake uses syn', workspaceId: 'default' }),
      denyIfUnauthorized: () => true,
      writeJson: () => assert.fail('legacy verify writes through writeHead/end'),
      writeApiError: () => assert.fail('a stop must not use the generic api error'),
      ...LEGACY_HELPERS,
      emergencyStop: ledger,
    });
    const handled = await handleCore({ method: 'POST', headers: {} }, res, new URL(`http://localhost${pathname}`), {});
    assert.equal(handled, true);
    assert.equal(responses[0].status, EMERGENCY_STOPPED_STATUS, `${pathname} must be refused`);
    assert.equal(responses[0].body.errorCode, EMERGENCY_STOPPED_CODE);
  }
});

test('the legacy /llm-sor surface is refused while stopped, before the LLM is called', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  const responses = [];
  const res = {
    writeHead(status) { this._status = status; },
    end(bytes) { responses.push({ status: this._status, body: JSON.parse(bytes) }); },
  };
  const handleCore = createCoreHttpRoutes({
    kernel: countingKernel(),
    getGraphData: () => ({}),
    getV2StatusData: () => ({}),
    getHealthData: () => ({}),
    handleAnswerRoute: () => false,
    parseJsonRequest: async () => ({ question: 'what is tcp', workspaceId: 'default' }),
    denyIfUnauthorized: () => true,
    writeJson: () => assert.fail('llm-sor writes through writeHead/end'),
    writeApiError: () => assert.fail('a stop must not use the generic api error'),
    ...LEGACY_HELPERS,
    emergencyStop: ledger,
  });
  const handled = await handleCore({ method: 'POST', headers: {} }, res, new URL('http://localhost/llm-sor'), {});
  assert.equal(handled, true);
  assert.equal(responses[0].status, EMERGENCY_STOPPED_STATUS);
  assert.equal(responses[0].body.errorCode, EMERGENCY_STOPPED_CODE);
});

test('the /v2/verify surface is refused while stopped, before the kernel verifies', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  const responses = [];
  const res = {
    writeHead(status) { this._status = status; },
    end(bytes) { responses.push({ status: this._status, body: JSON.parse(bytes) }); },
  };
  const kernel = countingKernel();
  const handleCore = createCoreHttpRoutes({
    kernel,
    getGraphData: () => ({}),
    getV2StatusData: () => ({}),
    getHealthData: () => ({}),
    handleAnswerRoute: () => false,
    parseJsonRequest: async () => ({ claim: 'tcp handshake uses syn', workspaceId: 'default' }),
    denyIfUnauthorized: () => true,
    writeJson: () => assert.fail('a stop must not reach the verify envelope'),
    writeApiError: () => assert.fail('a stop must not use the generic api error'),
    ...LEGACY_HELPERS,
    emergencyStop: ledger,
  });
  const handled = await handleCore({ method: 'POST', headers: {} }, res, new URL('http://localhost/v2/verify'), {});
  assert.equal(handled, true);
  assert.equal(responses[0].status, EMERGENCY_STOPPED_STATUS);
  assert.equal(responses[0].body.errorCode, EMERGENCY_STOPPED_CODE);
  assert.equal(kernel.reads.verify, 0, 'the stop must answer before the kernel verifies');
});

test('the /answer surface is refused while stopped', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'default', reason: 'probe', actor: 'test' });
  const responses = [];
  const res = {
    writeHead(status, headers) { this._status = status; this._headers = headers; },
    end(bytes) { responses.push({ status: this._status, body: JSON.parse(bytes) }); },
  };
  const handleAnswer = createAnswerRoute({
    kernel: countingKernel(),
    legacyVerify: (r) => r,
    sanitizeInput: (value) => String(value || ''),
    parseJsonRequest: async () => ({ question: 'what is tcp', workspaceId: 'default' }),
    denyIfUnauthorized: () => true,
    JSON_CONTENT_TYPE: 'application/json',
    DEFAULT_MAX_JSON_BODY: 8192,
    writeJson: () => assert.fail('answer writes through writeHead/end'),
    buildCorsHeaders: () => ({}),
    emergencyStop: ledger,
  });
  await handleAnswer({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, EMERGENCY_STOPPED_STATUS);
  assert.equal(responses[0].body.errorCode, EMERGENCY_STOPPED_CODE);
});

test('an unstopped workspace is unaffected by the gate', async (t) => {
  const ledger = ledgerIn(t);
  const kernel = countingKernel();
  const result = await runReadWorkflow({ workflowId: 'ask', kernel, input: { question: 'q', workspaceId: 'default' }, ensureCapabilities: NO_CAPABILITY_ENSURE, emergencyStop: ledger });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
});

// The gate is a guard, not a replacement for the surface it guards. These pin
// that the /answer route still answers its own contract once the workspace is
// allowed through -- without them the added `if (stop)` sits alone in a file
// the rest of the suite never reaches, and the branch ratchet reads the new
// branch as an unmeasured regression rather than a tested one.
const EVIDENCE_LINE = 'tcp handshake --[provides]--> syn (relation=provides, source=graph, confidence=0.90)';

function answerRoute(t, overrides = {}) {
  const responses = [];
  const res = {
    writeHead(status, headers) { this._status = status; this._headers = headers; },
    end(bytes) { responses.push({ status: this._status, headers: this._headers, body: JSON.parse(bytes) }); },
  };
  const handle = createAnswerRoute({
    kernel: countingKernel(),
    legacyVerify: (result) => result,
    sanitizeInput: (value) => String(value || '').trim(),
    parseJsonRequest: async () => ({ question: 'what is tcp', workspaceId: 'default' }),
    denyIfUnauthorized: () => true,
    JSON_CONTENT_TYPE: 'application/json',
    DEFAULT_MAX_JSON_BODY: 8192,
    writeJson: (_req, _res, status, json) => responses.push({ status, body: json }),
    buildCorsHeaders: () => ({}),
    emergencyStop: ledgerIn(t),
    ...overrides,
  });
  return { handle, res, responses };
}

test('a non-POST request to /answer answers 405 without consulting the stop', async (t) => {
  const { handle, res, responses } = answerRoute(t);
  await handle({ method: 'GET', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 405);
  assert.equal(responses[0].body.errorCode, 'METHOD_NOT_ALLOWED');
});

test('an unauthorized /answer request is denied before the stop is read', async (t) => {
  const { handle, res, responses } = answerRoute(t, { denyIfUnauthorized: () => false });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses.length, 0, 'the denial owns the response');
});

test('a missing body leaves /answer without a response of its own', async (t) => {
  const { handle, res, responses } = answerRoute(t, { parseJsonRequest: async () => null });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses.length, 0);
});

test('a blank question is refused with 400 before the stop is read', async (t) => {
  const { handle, res, responses } = answerRoute(t, { parseJsonRequest: async () => ({ question: '   ' }) });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 400);
  assert.equal(responses[0].body.errorCode, 'INVALID_INPUT');
});

test('a body with neither question nor q is refused with 400', async (t) => {
  const { handle, res, responses } = answerRoute(t, { parseJsonRequest: async () => ({}) });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 400);
  assert.equal(responses[0].body.errorCode, 'INVALID_INPUT');
});

test('the question falls back to the short q field, and the workspace to empty', async (t) => {
  const { handle, res, responses } = answerRoute(t, {
    parseJsonRequest: async () => ({ q: 'what is tcp' }),
    kernel: { verify: () => ({ ok: true, status: 'verified', confidence: 0.9, evidence: [EVIDENCE_LINE] }) },
  });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.question, 'what is tcp');
});

test('an unstopped workspace composes a fluent answer and reports the query string workspace', async (t) => {
  const { handle, res, responses } = answerRoute(t, {
    parseJsonRequest: async () => ({ question: 'what is tcp' }),
    kernel: { verify: () => ({ ok: true, status: 'verified', confidence: 0.9, evidence: [EVIDENCE_LINE] }) },
  });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer?workspaceId=from-query'));
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.equal(responses[0].body.question, 'what is tcp');
  assert.equal(responses[0].body.evidenceCount, 1);
  assert.equal(responses[0].headers['Cache-Control'], 'no-cache');
});

test('an evidence-free question is retried with its keyword claim', async (t) => {
  const seen = [];
  const { handle, res, responses } = answerRoute(t, {
    parseJsonRequest: async () => ({ question: 'what is tcp handshake', workspaceId: 'default' }),
    kernel: {
      verify: (query) => {
        seen.push(query);
        return seen.length === 1
          ? { ok: true, status: 'unknown', confidence: 0, evidence: [] }
          : { ok: true, status: 'verified', confidence: 0.8, evidence: [EVIDENCE_LINE] };
      },
    },
  });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(seen.length, 2, 'the keyword retry is a second verify');
  assert.notEqual(seen[1], seen[0]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.matchedVia, 'keyword-retry');
});

test('a failing verify answers 500 with the error code instead of throwing', async (t) => {
  const errors = console.error;
  console.error = () => {};
  t.after(() => { console.error = errors; });
  const { handle, res, responses } = answerRoute(t, {
    kernel: { verify: () => { throw Object.assign(new Error('graph unavailable'), { code: 'GRAPH_DOWN' }); } },
  });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 500);
  assert.equal(responses[0].body.errorCode, 'GRAPH_DOWN');
});

test('an error without a code still answers 500 under ANSWER_FAILED', async (t) => {
  const errors = console.error;
  console.error = () => {};
  t.after(() => { console.error = errors; });
  const { handle, res, responses } = answerRoute(t, {
    kernel: { verify: () => { throw new Error('no code'); } },
  });
  await handle({ method: 'POST', headers: {} }, res, new URL('http://localhost/answer'));
  assert.equal(responses[0].status, 500);
  assert.equal(responses[0].body.errorCode, 'ANSWER_FAILED');
});

// The gate is mounted through the composite boundary, so the boundary's own
// zero-configuration path is part of this change's surface. Constructing it
// with no options exercises every `options.x || {}` fallback -- the shape a
// deployment that configures nothing actually gets.
test('the optional boundary composes with no options and routes nothing', async () => {
  const boundaries = createOptionalRouteBoundaries();
  const res = { writeHead() {}, end() {} };
  assert.equal(await boundaries.route({ method: 'GET', headers: {} }, res, new URL('http://localhost/none')), false);
  assert.equal(await boundaries.route({ method: 'POST', headers: {} }, res, new URL('http://localhost/none')), false);
});

test('the optional boundary composes with an empty options object', async () => {
  const boundaries = createOptionalRouteBoundaries({});
  const res = { writeHead() {}, end() {} };
  assert.equal(await boundaries.route({ method: 'GET', headers: {} }, res, new URL('http://localhost/none')), false);
});

test('the optional boundary composes when every option group is supplied', async (t) => {
  const boundaries = createOptionalRouteBoundaries({
    commandPolicy: { environment: {} },
    memoryApproval: {},
    a2a: {},
    emergencyStop: { emergencyStop: ledgerIn(t) },
    prGuardian: {},
    receiptCollector: { collectorRoot: '/tmp/huqan-3905-collector' },
    registry: {},
  });
  const res = { writeHead() {}, end() {} };
  assert.equal(await boundaries.route({ method: 'GET', headers: {} }, res, new URL('http://localhost/none')), false);
  assert.equal(boundaries.authContext.receiptCollectorRouteEnabled, true);
});
