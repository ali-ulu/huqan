'use strict';

// Pins what mcpServer.js answers when the real MCP gate refuses a call, what the
// operator-authorised tools return without authority, the read-only dry run,
// every JSON-RPC method, and the export surface (#2142).
//
// test/mcp-tool-dispatch.test.js already pins each tool's handler with the gate
// forced open. This file covers the other side of that gate, which it cannot:
// review queuing (persisted, unavailable, failing, unconfirmed stores), the
// Human Oversight case, the dry run, and the block.
//
// Approval ids and clocks are made deterministic before mcpServer.js loads,
// because lib/mcp-approval-store.js reads them when it is required.
//
// Regenerate only on purpose: UPDATE_MCP_GATED_FIXTURE=1 node --test <this file>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-server-gated-responses.json');
const UNDEFINED = '__undefined__';

const sanitizers = require('../lib/mcp-input-sanitizers');
let clock = 0;
let sequence = 0;
sanitizers.nowMs = () => 1_700_000_000_000 + (clock += 1000);
sanitizers.newApprovalId = () => `appr_fixture_${String(sequence += 1).padStart(3, '0')}`;

const mcp = require('../mcpServer');

// Wall-clock times appear both as whole values and inside serialised JSON strings.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ISO_TIME_IN_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g;
const ERROR_REF = /\(ref: [^)]+\)/g;
// Provenance and trace ids are random per call; their presence and shape are what is pinned.
// 16 hex = legacy sha1 mint, 32 hex = sha256 mint since #2610 — both redact.
const PROVENANCE_ID = /\bprov_(?:[0-9a-f]{16}|[0-9a-f]{32})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
// The external tool policy mints its own approval ids from the clock and randomness.
const POLICY_APPROVAL_ID = /\bapproval-\d{13}-[0-9a-f]{12}\b/g;

// gitleaks' generic-api-key rule matches a key-like field name beside a quoted
// value, whatever the value is. An approval key is `mcp.<tool>.<id>` of its own
// record, so that relationship is written as a marker; any other shape stays raw.
const APPROVAL_KEY_FIELD = ['approval', 'Key'].join('');

function snapshot(value) {
  return JSON.parse(JSON.stringify(value, function replace(key, item) {
    if (key === APPROVAL_KEY_FIELD && typeof item === 'string' && item && this) {
      if (item === `mcp.${this.tool}.${this.id}`) return '<mcp.tool.id>';
      // Oversight metadata carries the approval id beside the key, but no tool field.
      if (typeof this.approvalId === 'string' && this.approvalId
        && /^mcp\.huqan\.[\w-]+\./.test(item) && item.endsWith(`.${this.approvalId}`)) {
        return '<mcp.tool.approvalId>';
      }
    }
    if (item === undefined) return UNDEFINED;
    if (typeof item === 'bigint') return `${item}n`;
    if (typeof item === 'string' && ISO_TIME.test(item)) return '<iso-time>';
    if (typeof item === 'string') {
      return item.replace(ERROR_REF, '(ref: <ref>)').replace(PROVENANCE_ID, 'prov_<random>').replace(UUID, '<uuid>').replace(ISO_TIME_IN_TEXT, '<iso-time>')
        .replace(POLICY_APPROVAL_ID, 'approval-<ms>-<random>');
    }
    return item;
  }));
}

function resetClocks() {
  clock = 0;
  sequence = 0;
}

async function capture(fn) {
  resetClocks();
  try {
    return snapshot({ value: await fn() });
  } catch (error) {
    return { threw: String(error && error.message).replace(ERROR_REF, '(ref: <ref>)') };
  }
}

function recordingKernel(calls) {
  const record = (label, value) => (...args) => {
    calls.push([label, ...snapshot(args)]);
    return typeof value === 'function' ? value(...args) : value;
  };
  return {
    learn: record('kernel.learn', { ok: true, via: 'learn' }),
    ask: record('kernel.ask', question => ({ ok: true, via: 'ask', question })),
    // A kernel verify always carries its confidence (kernel-envelope
    // validateResult); without it the MCP output gate withholds the result (#3483).
    verify: record('kernel.verify', { ok: true, via: 'verify', data: { status: 'verified', confidence: 0.9 } }),
    reason: record('kernel.reason', { ok: true, via: 'reason' }),
    compare: record('kernel.compare', { ok: true, via: 'compare' }),
    dream: record('kernel.dream', { ok: true, via: 'dream' }),
    ok: record('kernel.ok', (type, data) => ({ ok: true, type, data })),
    fail: record('kernel.fail', (type, code, message) => ({ ok: false, type, error: { code, message } })),
    recordGateDecision: record('kernel.recordGateDecision', undefined),
  };
}

function store(kind, calls) {
  if (kind === 'none') return null;
  const saveToolApproval = (approval) => {
    calls.push(['store.saveToolApproval', snapshot(approval)]);
    if (kind === 'throws') throw new Error('disk full');
    if (kind === 'unconfirmed') return undefined;
    return { ...approval, tool_name: approval.tool, approval_key: approval.approvalKey };
  };
  return {
    saveToolApproval,
    listUnresolvedToolApprovals: () => [],
    countPendingToolApprovals: () => 0,
    countUnresolvedToolApprovals: () => 0,
    getToolApprovalById: () => null,
  };
}

function recordingApprovalStore(calls) {
  const record = (label, value) => (...args) => {
    calls.push([label, ...snapshot(args)]);
    return value;
  };
  return {
    listUnresolvedToolApprovals: record('store.listUnresolvedToolApprovals', [{ id: 'a1', tool_name: 'huqan.learn', status: 'pending' }]),
    countPendingToolApprovals: record('store.countPendingToolApprovals', 1),
    countUnresolvedToolApprovals: record('store.countUnresolvedToolApprovals', 1),
    getToolApprovalById: record('store.getToolApprovalById', null),
  };
}

function oversight(kind, calls) {
  if (kind === 'none') return undefined;
  const fail = kind === 'refuses' ? { ok: false, reason: 'requester_not_allowed' } : null;
  return {
    createReviewCase: (input) => {
      calls.push(['oversight.createReviewCase', snapshot(input)]);
      if (kind === 'throws') throw new Error('oversight down');
      return fail || { ok: true, reviewCase: { caseId: input.caseId, status: 'pending_review' } };
    },
    getReviewCase: () => ({ ok: false }),
    decide: () => ({ ok: false }),
    executeApproved: () => ({ ok: false }),
  };
}

// Arguments chosen to land on each gate outcome: benign reads, mutations that
// require review, agent execution, external tool policy, and secret material.
const GATED_CALLS = [
  ['huqan.learn', { text: 'water boils at 100 degrees' }],
  ['huqan.learn', { text: 'my api_key is sk-live-1234567890abcdef1234' }],
  ['huqan.ask', { question: 'what is water' }],
  ['huqan.verify', { claim: 'water is wet' }],
  ['huqan.plan', { goal: 'summarise the repo', maxSteps: 3 }],
  ['huqan.agent', { goal: 'delete every file in the repo', maxSteps: 4 }],
  ['huqan.agent', { goal: 'summarise the repo' }],
  ['huqan.policy', { tool: 'shell', input: 'rm -rf /', goal: 'clean up' }],
  ['huqan.reason', { subject: 'water' }],
  ['huqan.compare', { left: 'a', right: 'b' }],
  ['huqan.dream', { depth: 2 }],
  ['huqan.fractal-learn', { text: 'fractal learning input' }],
  ['huqan.self-evolve', { mode: 'apply' }],
  ['huqan.search', { query: 'water' }],
  ['huqan.status', {}],
  ['huqan.ingest_preview', { source: 'notes', text: 'hello' }],
  ['huqan.ingest_execute', { sourceType: 'markdown', path: 'README.md' }],
  ['huqan.nope', {}],
];

const OPERATOR_TOOLS = ['huqan.approve', 'huqan.approvals', 'huqan.approval_detail', 'huqan.agent_resume', 'huqan.emergency_stop'];

async function gatedScenarios() {
  const out = {};
  for (const [index, [name, args]] of GATED_CALLS.entries()) {
    for (const storeKind of ['persists', 'none', 'throws', 'unconfirmed']) {
      const calls = [];
      const runtime = { approvalStore: store(storeKind, calls) };
      out[`gated/${index}/${name}/${storeKind}`] = await capture(async () => ({
        output: await mcp.callTool(recordingKernel(calls), { name, arguments: args }, runtime),
        calls,
      }));
    }
  }
  for (const oversightKind of ['ok', 'refuses', 'throws']) {
    for (const [index, args] of [[0, GATED_CALLS[0][1]], [1, GATED_CALLS[1][1]]]) {
      const calls = [];
      const runtime = {
        approvalStore: store('persists', calls),
        humanOversightApprovalRuntime: oversight(oversightKind, calls),
        humanOversightRequesterContext: { actorId: 'agent-1', actorType: 'agent' },
      };
      out[`oversight/${oversightKind}/learn-${index}`] = await capture(async () => ({
        output: await mcp.callTool(recordingKernel(calls), { name: 'huqan.learn', arguments: args }, runtime),
        calls,
      }));
    }
  }
  return out;
}

async function operatorScenarios() {
  const out = {};
  for (const name of OPERATOR_TOOLS) {
    const args = { approvalId: 'a1', runId: 'r1', workspaceId: 'default', decision: 'approved' };
    const cases = {
      noAuthority: [{}, {}],
      wrongStaticToken: [{ operatorToken: 'wrong' }, { operatorToken: 'right' }],
      capabilityWithoutSecret: [{ operatorCapability: 'cap' }, {}],
      forgedCapability: [{ operatorCapability: 'not-a-capability' }, { operatorSecret: 'secret', operatorCapabilityNonces: new Map() }],
      emptyStaticToken: [{ operatorToken: '' }, { operatorToken: '' }],
    };
    for (const [caseName, [extraParams, runtime]] of Object.entries(cases)) {
      const calls = [];
      out[`operator/${name}/${caseName}`] = await capture(async () => ({
        output: await mcp.callTool(recordingKernel(calls), { name, arguments: args, ...extraParams }, runtime),
        calls,
      }));
    }
  }
  // Authorised reads with a 100-character workspace id: inside the capability's
  // 256-byte binding limit, but long enough that the bound the handler applies
  // to the id is visible in what reaches the store.
  for (const name of ['huqan.approvals', 'huqan.approval_detail']) {
    const args = { approvalId: 'a1', workspaceId: 'w'.repeat(100), limit: 3 };
    const calls = [];
    const runtime = { approvalStore: recordingApprovalStore(calls), operatorSecret: 'secret', operatorCapabilityNonces: new Map() };
    out[`operator/${name}/authorised-long-workspace`] = await capture(async () => {
      const operatorCapability = mcp.createMcpOperatorCapability({ secret: 'secret', ...mcp.operatorCapabilityBinding(name, args) });
      return {
        output: await mcp.callTool(recordingKernel(calls), { name, arguments: args, operatorCapability }, runtime),
        calls,
      };
    });
  }
  const binding = mcp.operatorCapabilityBinding('huqan.approve', { approvalId: 'a1', workspaceId: 'w', decision: 'approved' });
  out['operator/binding/approve'] = snapshot(binding);
  out['operator/binding/agent_resume'] = snapshot(mcp.operatorCapabilityBinding('huqan.agent_resume', { checkpointId: 'c1' }));
  out['operator/binding/other'] = snapshot(mcp.operatorCapabilityBinding('huqan.approvals', {}));
  return out;
}

async function dryRunScenarios() {
  const out = {};
  const cases = [
    ['huqan.learn', { text: 'x'.repeat(300) }],
    ['huqan.learn', {}],
    ['axiom.learn', { text: 'legacy alias' }],
    ['huqan.search', { query: 'q', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
  ];
  for (const [index, [name, args]] of cases.entries()) {
    const calls = [];
    out[`dryRun/${index}/${name}`] = await capture(async () => ({
      output: mcp.executeReadOnlyDryRun(recordingKernel(calls), name, args),
      calls,
    }));
  }
  return out;
}

async function jsonRpcScenarios() {
  const out = {};
  const calls = [];
  const kernel = recordingKernel(calls);
  const server = mcp.createServer({
    kernel,
    approvalStore: store('persists', calls),
    operatorCapabilityNonces: new Map(),
    operatorToken: 'operator-secret',
  });
  const requests = {
    notObject: null,
    initialize: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    initialized: { jsonrpc: '2.0', method: 'notifications/initialized' },
    ping: { jsonrpc: '2.0', id: 'p', method: 'ping' },
    shutdown: { jsonrpc: '2.0', id: 9, method: 'shutdown' },
    unknownMethod: { jsonrpc: '2.0', id: 2, method: 'resources/list' },
    toolsCallAllowed: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'huqan.ask', arguments: { question: 'q' } } },
    toolsCallReview: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'huqan.learn', arguments: { text: 'water is wet' } } },
    toolsCallUnknown: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'huqan.nope' } },
    toolsCallNoParams: { jsonrpc: '2.0', id: 6, method: 'tools/call' },
  };
  for (const [name, request] of Object.entries(requests)) {
    calls.length = 0;
    out[`jsonrpc/${name}`] = await capture(async () => ({ response: await server.handleRequest(request), calls: [...calls] }));
  }
  out['jsonrpc/toolsList'] = snapshot(server.handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list' }).result.tools.map(tool => tool.name));
  const throwing = { ...kernel, ask: () => { throw new Error('kernel exploded'); } };
  const failing = mcp.createServer({ kernel: throwing, approvalStore: store('persists', []), operatorCapabilityNonces: new Map() });
  out['jsonrpc/toolsCallThrows'] = await capture(() => failing.handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'huqan.ask', arguments: { question: 'q' } } }));
  // createServer must hand its Human Oversight options to every tools/call.
  const overseenCalls = [];
  const overseen = mcp.createServer({
    kernel: recordingKernel(overseenCalls),
    approvalStore: store('persists', overseenCalls),
    operatorCapabilityNonces: new Map(),
    humanOversightApprovalRuntime: oversight('ok', overseenCalls),
    humanOversightRequesterContext: { actorId: 'agent-1', actorType: 'agent' },
  });
  out['jsonrpc/toolsCallWithOversight'] = await capture(async () => ({
    response: await overseen.handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'huqan.learn', arguments: { text: 'water boils at 100 degrees' } } }),
    calls: overseenCalls,
  }));
  // Not pinned: a kernel method that returns a rejected promise. The verdict
  // surface spreads the promise without awaiting it, so the rejection is
  // unhandled -- recorded as a separate finding, not frozen into this fixture.
  return out;
}

function surface() {
  return snapshot({
    exports: Object.keys(mcp),
    types: Object.fromEntries(Object.entries(mcp).map(([key, value]) => [key, typeof value])),
    constants: {
      PROTOCOL_VERSION: mcp.PROTOCOL_VERSION,
      MCP_MAX_FRAME_BYTES: mcp.MCP_MAX_FRAME_BYTES,
      MCP_MAX_JSON_DEPTH: mcp.MCP_MAX_JSON_DEPTH,
      MCP_MAX_JSON_VALUES: mcp.MCP_MAX_JSON_VALUES,
      SERVER_NAME: mcp.SERVER_NAME,
      MCP_OPERATOR_TOKEN_ENV: mcp.MCP_OPERATOR_TOKEN_ENV,
      VERIFY_STATUS: mcp.VERIFY_STATUS,
    },
    schemas: {
      TOOL_SCHEMAS: mcp.TOOL_SCHEMAS.map(tool => tool.name),
      WORKFLOW_TOOL_SCHEMAS: mcp.WORKFLOW_TOOL_SCHEMAS,
      OPERATOR_TOOL_SCHEMAS: mcp.OPERATOR_TOOL_SCHEMAS.map(tool => tool.name),
      MODEL_VISIBLE_TOOL_SCHEMAS: mcp.MODEL_VISIBLE_TOOL_SCHEMAS.map(tool => tool.name),
      frozen: [mcp.WORKFLOW_TOOL_SCHEMAS, mcp.OPERATOR_TOOL_SCHEMAS, mcp.MODEL_VISIBLE_TOOL_SCHEMAS].map(Object.isFrozen),
    },
    canonicalNames: [...mcp.CANONICAL_MCP_TOOL_NAMES],
    legacyNames: [...mcp.LEGACY_MCP_TOOL_NAMES],
  });
}

async function observe() {
  return {
    surface: surface(),
    runs: {
      ...(await gatedScenarios()),
      ...(await operatorScenarios()),
      ...(await dryRunScenarios()),
      ...(await jsonRpcScenarios()),
    },
  };
}

test('mcpServer gated responses match the recorded characterisation', async () => {
  const originalError = console.error;
  console.error = () => {};
  let actual;
  let again;
  try {
    actual = await observe();
    again = await observe();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(again, actual, 'the scenarios must be deterministic before they can pin anything');

  if (process.env.UPDATE_MCP_GATED_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    // One scenario per line keeps a real behaviour change reviewable as a one-line diff.
    const runs = Object.entries(actual.runs).map(([key, run]) => `    ${JSON.stringify(key)}: ${JSON.stringify(run)}`);
    fs.writeFileSync(FIXTURE, `{\n  "surface": ${JSON.stringify(actual.surface)},\n  "runs": {\n${runs.join(',\n')}\n  }\n}\n`);
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(actual.surface, expected.surface);
  assert.deepEqual(Object.keys(actual.runs), Object.keys(expected.runs));
  for (const key of Object.keys(expected.runs)) {
    assert.deepEqual(actual.runs[key], expected.runs[key], key);
  }
});
