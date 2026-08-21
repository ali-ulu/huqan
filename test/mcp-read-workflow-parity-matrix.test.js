'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { callTool } = require('../mcpServer');
const { runReadWorkflow } = require('../lib/http/read-workflow-actions');
const { buildTrustReceipt } = require('../lib/provenance-query');
const { workflowForMcpTool } = require('../lib/workflow-contract');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { toCanonicalVerifyStatus } = require('../lib/verify-status-vocabulary');

function createReadFixture() {
  const node = {
    id: 'alpha',
    label: 'Alpha',
    workspaceId: 'team-a',
    confidence: 0.91,
    provenance: {
      provenanceId: 'prov-alpha',
      sourceRef: 'doc:alpha',
      sourceType: 'document',
      actor: 'fixture',
      timestamp: '2026-08-15T00:00:00Z',
      confidence: 0.91,
      workspaceId: 'team-a',
      trustPolicyVersion: 'test-policy-1',
    },
  };
  const graph = {
    _nodes: { alpha: node },
    _edges: [],
    getNodes(workspaceId) {
      assert.equal(workspaceId, 'team-a');
      return this._nodes;
    },
    getNode(id, workspaceId) {
      return id === node.id && workspaceId === node.workspaceId ? node : null;
    },
    getCandidateClaims() {
      return [];
    },
    getAuditEvents() {
      return [];
    },
  };
  const kernel = {
    graph,
    ask(question) {
      assert.equal(question, 'What is Alpha?');
      return {
        ok: true,
        type: 'ask',
        data: { answer: 'Alpha is a documented fixture.', confidence: 0.72 },
        evidence: [{ sourceRef: 'doc:alpha' }],
        error: null,
        meta: {},
      };
    },
    verify(statement, options = {}) {
      assert.equal(statement, 'Alpha is documented.');
      assert.equal(options.workspaceId, 'team-a');
      return {
        ok: true,
        type: 'verify',
        data: { status: 'verified', confidence: 0.91, workspaceId: 'team-a' },
        evidence: [{ sourceRef: 'doc:alpha' }],
        error: null,
        meta: {},
      };
    },
    async runCapability(name, input) {
      assert.equal(name, 'devilAdvocate');
      assert.deepEqual(input, { text: 'Alpha is documented.', workspaceId: 'default' });
      return {
        ok: true,
        type: 'advocate',
        data: { mode: 'counter', counterArguments: ['Check the source.'], confidence: 0.61 },
        evidence: [{ sourceRef: 'doc:alpha' }],
        error: null,
        meta: {},
      };
    },
    learn() {},
  };
  return { graph, kernel };
}

function mcpArgsFor(workflowId) {
  switch (workflowId) {
    case 'ask':
      return { workspaceId: 'default', question: 'What is Alpha?' };
    case 'verify':
      return { workspaceId: 'team-a', statement: 'Alpha is documented.' };
    case 'advocate':
      return { workspaceId: 'default', claim: 'Alpha is documented.' };
    case 'memory-search':
      return { workspaceId: 'team-a', query: 'alpha' };
    case 'trust-receipt':
      return { workspaceId: 'team-a', targetId: 'alpha' };
    default:
      throw new Error(`Unknown read workflow fixture: ${workflowId}`);
  }
}

function httpArgsFor(workflowId) {
  switch (workflowId) {
    case 'ask':
      return { workspaceId: 'default', question: 'What is Alpha?' };
    case 'verify':
      return { workspaceId: 'team-a', claim: 'Alpha is documented.' };
    case 'advocate':
      return { workspaceId: 'default', claim: 'Alpha is documented.' };
    case 'memory-search':
      return { workspaceId: 'team-a', query: 'alpha' };
    default:
      throw new Error(`Unknown HTTP read workflow fixture: ${workflowId}`);
  }
}

function canonicalizeVerifyData(workflowId, data) {
  if (workflowId !== 'verify' || !data || typeof data !== 'object') return data;
  return { ...data, status: toCanonicalVerifyStatus(data.status) };
}

function comparableEnvelope(workflowId, result) {
  return {
    ok: result.ok,
    status: result.status,
    data: canonicalizeVerifyData(workflowId, result.data),
    evidence: result.evidence,
    confidence: result.confidence,
    receiptId: result.receiptId || null,
    error: result.error || null,
  };
}

function assertCommonEnvelopeFields(result, workflowId, expectedReceiptId = null) {
  for (const field of ['ok', 'status', 'data', 'evidence', 'confidence', 'receiptId', 'error']) {
    assert.equal(Object.hasOwn(result, field), true, `${workflowId} must publish ${field}`);
  }
  assert.equal(result.workflowId, workflowId);
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.approval, null);
  assert.equal(result.receiptId, expectedReceiptId);
  assert.equal(result.error, null);
  assert.equal(Array.isArray(result.evidence), true);
}

function createCliFixture(kernel) {
  return {
    parse(commandLine) {
      const [command, ...args] = commandLine.split(' ');
      return { command, args, workflowId: command === 'sor' ? 'ask' : command === 'verify' ? 'verify' : null };
    },
    _evaluateCliGate() {
      return { canExecute: true, decision: 'allow', reason: 'read_only_allow' };
    },
    async execute(command, args) {
      if (command === 'sor') return kernel.ask(args.join(' '));
      if (command === 'verify') return kernel.verify(args.join(' '), { workspaceId: 'team-a' });
      throw new Error(`Unsupported CLI fixture command: ${command}`);
    },
  };
}

async function cliJson(cli, args) {
  let output = null;
  await runCliArgv([...args, '--json'], { cli, stdout: value => { output = JSON.parse(value); } });
  return output;
}

test('read workflows preserve field-level parity across MCP and HTTP', async () => {
  const { kernel } = createReadFixture();
  const cases = [
    ['ask', 'ask'],
    ['verify', 'verify'],
    ['advocate', 'advocate'],
    ['search', 'memory-search'],
  ];

  for (const [toolName, workflowId] of cases) {
    const args = mcpArgsFor(workflowId);
    const mcp = await callTool(kernel, { name: `huqan.${toolName}`, arguments: args });
    const http = (await runReadWorkflow({ workflowId, kernel, input: httpArgsFor(workflowId) })).body;

    assertCommonEnvelopeFields(mcp, workflowId);
    assert.equal(http.ok, true, `${workflowId} HTTP fixture must complete`);
    assert.deepEqual(comparableEnvelope(workflowId, mcp), comparableEnvelope(workflowId, http));
  }
});

test('trust-read publishes the same canonical receipt fields without fabricating a receipt', () => {
  const { graph, kernel } = createReadFixture();
  const filters = mcpArgsFor('trust-receipt');
  const mcp = callTool(kernel, { name: 'huqan.trust_receipt', arguments: filters });
  const canonical = buildTrustReceipt({ ...filters, receiptId: mcp.data.receiptId }, { target: graph });

  assertCommonEnvelopeFields(mcp, 'trust-receipt', canonical.receiptId);
  assert.equal(mcp.data.receiptId, canonical.receiptId);
  assert.equal(mcp.data.status, canonical.status);
  assert.equal(mcp.data.workspaceId, canonical.workspaceId);
  assert.deepEqual(mcp.data.provenance, canonical.provenance);
  assert.equal(mcp.data.confidence, canonical.confidence);
  assert.equal(mcp.receiptId, canonical.receiptId);
  assert.equal(mcp.data.canonical, true);
});

test('CLI ask and verify use the same canonical read data and null receipt semantics', async () => {
  const { kernel } = createReadFixture();
  const cli = createCliFixture(kernel);
  const askMcp = callTool(kernel, { name: 'huqan.ask', arguments: mcpArgsFor('ask') });
  const verifyMcp = callTool(kernel, { name: 'huqan.verify', arguments: mcpArgsFor('verify') });
  const askCli = await cliJson(cli, ['sor', 'What', 'is', 'Alpha?']);
  const verifyCli = await cliJson(cli, ['verify', 'Alpha', 'is', 'documented.']);

  assert.equal(askCli.workflowId, 'ask');
  assert.equal(verifyCli.workflowId, 'verify');
  assert.deepEqual(askCli.data, askMcp.data);
  assert.deepEqual(canonicalizeVerifyData('verify', verifyCli.data), canonicalizeVerifyData('verify', verifyMcp.data));
  for (const result of [askCli, verifyCli]) {
    assert.equal(result.status, 'completed');
    assert.equal(result.receiptId, null);
    assert.equal(result.error, null);
    assert.equal(Array.isArray(result.evidence), true);
  }
});

test('read workflow availability boundaries remain explicit', () => {
  assert.equal(workflowForMcpTool('huqan.ask').availability.cli, true);
  assert.equal(workflowForMcpTool('huqan.verify').availability.cli, true);
  assert.equal(workflowForMcpTool('huqan.advocate').availability.cli, false);
  assert.equal(workflowForMcpTool('huqan.search').availability.cli, false);
  assert.equal(workflowForMcpTool('huqan.trust_receipt').availability.cli, false);
});

/**
 * The parity fixture above deliberately stubs `runCapability` into always
 * succeeding, and gives its kernel no capability surface at all. That proves
 * the two envelopes agree *once the capability runs* -- it says nothing about
 * whether the capability is reachable on a given surface, which is where the
 * real defect lived: `mcpServer.js` builds its kernel with `loadPlugins: false`
 * and `pluginCapabilities` off, so `advocate` threw `CAPABILITY_REQUIRED` and
 * MCP reported an opaque `INTERNAL_ERROR` ref on every single call, while HTTP
 * served the same workflow normally.
 *
 * These cases pin the answer at that boundary rather than the boundary itself:
 * a surface may legitimately decline to enable plugins, but it has to say so.
 */
function capabilityKernel({ pluginCapabilities, devilAdvocate }) {
  return {
    hasCapability(name) {
      return name === 'pluginCapabilities' ? pluginCapabilities : false;
    },
    getCapability(name) {
      return name === 'devilAdvocate' && devilAdvocate ? { name, plugin: 'devil-advocate' } : null;
    },
    async runCapability() {
      throw new Error('runCapability must not be reached when the capability is unavailable');
    },
  };
}

test('advocate reports an unavailable capability instead of throwing an internal error', async () => {
  const cases = [
    ['plugin capabilities disabled', { pluginCapabilities: false, devilAdvocate: false }],
    ['plugin capabilities on, devil-advocate not registered', { pluginCapabilities: true, devilAdvocate: false }],
  ];

  for (const [label, capabilities] of cases) {
    const result = await runReadWorkflow({
      workflowId: 'advocate',
      kernel: capabilityKernel(capabilities),
      input: { workspaceId: 'default', claim: 'Alpha is documented.' },
    });

    assert.equal(result.body.ok, false, label);
    assert.equal(result.body.status, 'capability_not_available', label);
    assert.equal(result.body.error.code, 'CAPABILITY_NOT_AVAILABLE', label);
    assert.match(result.body.error.message, /advocate/, label);
  }
});

test('advocate still runs when the surface does enable the capability', async () => {
  const kernel = {
    hasCapability: (name) => name === 'pluginCapabilities',
    getCapability: (name) => (name === 'devilAdvocate' ? { name, plugin: 'devil-advocate' } : null),
    async runCapability(name, input) {
      assert.equal(name, 'devilAdvocate');
      assert.deepEqual(input, { text: 'Alpha is documented.', workspaceId: 'default' });
      return { ok: true, type: 'advocate', data: { mode: 'counter' }, evidence: [], error: null, meta: {} };
    },
  };

  const result = await runReadWorkflow({
    workflowId: 'advocate',
    kernel,
    input: { workspaceId: 'default', claim: 'Alpha is documented.' },
  });

  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'completed');
  assert.equal(result.body.data.mode, 'counter');
});
