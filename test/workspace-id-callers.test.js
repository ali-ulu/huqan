'use strict';

/**
 * #4032: ten modules carried their own normalizeWorkspaceId after #1099 had
 * centralised it, and every copy sent a supplied non-string id to the shared
 * 'default' tenant. These tests pin each former copy's entry point to the
 * canonical rule in lib/workspace-id.js. The single-definition gate stops the
 * copies coming back; this file proves the callers actually fail closed, which
 * the gate cannot see.
 *
 * Each module's own tests only use string ids, where the loose and canonical
 * rules agree -- which is how the drift went unnoticed.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { isRecordInWorkspace, WORKSPACE_ID_INVALID } = require('../lib/workspace-id');
const { buildApprovalRequest } = require('../lib/approval-schema');
const { reviewConflictCandidate } = require('../lib/conflict-candidate-review');
const { recordFitnessEntry } = require('../lib/fitness-history');
const { buildHypothesisCandidate, generateHypotheses } = require('../lib/graph-hypotheses');
const { buildFeedbackStats } = require('../lib/hypothesis-feedback');
const { buildFitnessReport } = require('../lib/hypothesis-fitness');
const { reviewHypothesisCandidate } = require('../lib/hypothesis-review');
const { applyThresholds } = require('../lib/hypothesis-thresholds');
const { runSelfEvolveAdapter } = require('../lib/self-evolve-adapter');
const { probeSelfEvolve } = require('../lib/self-evolve-probe');
const { executeMcpSelfEvolve } = require('../lib/mcp/self-evolve-tool');

const NON_STRING_IDS = [42, {}, [], true];
const TOO_LONG_ID = 'w'.repeat(200);

function rejectsWorkspace(fn) {
  assert.throws(fn, (error) => error.code === WORKSPACE_ID_INVALID);
}

// A private directory, not a fixed name in the shared temp dir: the stores
// these modules hang off memoryPath must never land somewhere predictable.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4032-store-'));
after(() => fs.rmSync(storeDir, { recursive: true, force: true }));

function graphOf(nodes = [], edges = []) {
  return {
    memoryPath: path.join(storeDir, 'memory.json'),
    getNodes: () => nodes,
    getAllEdges: () => edges,
  };
}

function kernelOf(graph = graphOf()) {
  return {
    graph,
    dream: () => [],
    entropy: () => 0,
    getCandidateClaims: () => [],
  };
}

const CALLERS = {
  'graph-hypotheses generateHypotheses': (id) => generateHypotheses(graphOf(), { workspaceId: id }),
  'graph-hypotheses buildHypothesisCandidate': (id) => buildHypothesisCandidate({ rule: 'X', target: 'a', gerekce: 'g' }, id),
  'hypothesis-fitness buildFitnessReport': (id) => buildFitnessReport(kernelOf(), { workspaceId: id }),
  'hypothesis-feedback buildFeedbackStats': (id) => buildFeedbackStats(kernelOf(), { workspaceId: id }),
  'hypothesis-review reviewHypothesisCandidate': (id) => reviewHypothesisCandidate(kernelOf(), { workspaceId: id, candidateId: 'c', decision: 'accept' }),
  'conflict-candidate-review reviewConflictCandidate': (id) => reviewConflictCandidate(kernelOf(), { workspaceId: id, candidateId: 'c', decision: 'accept' }),
  'hypothesis-thresholds applyThresholds': (id) => applyThresholds(kernelOf(), id, []),
  'self-evolve-probe probeSelfEvolve': (id) => probeSelfEvolve(kernelOf(), { workspaceId: id }),
  'self-evolve-adapter runSelfEvolveAdapter': (id) => runSelfEvolveAdapter(kernelOf(), { workspaceId: id }),
};

for (const [name, call] of Object.entries(CALLERS)) {
  test(`#4032 ${name} rejects a supplied non-string or over-long workspace id`, () => {
    for (const id of [...NON_STRING_IDS, TOO_LONG_ID]) rejectsWorkspace(() => call(id));
  });
}

test('#4032 recordFitnessEntry refuses a report scoped to an invalid workspace and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4032-fitness-'));
  try {
    const historyPath = path.join(dir, 'fitness.jsonl');
    for (const id of NON_STRING_IDS) {
      rejectsWorkspace(() => recordFitnessEntry(historyPath, { meta: { workspaceId: id } }));
    }
    assert.equal(fs.existsSync(historyPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#4032 an omitted or blank workspace id still means default for the former copies', () => {
  for (const id of [undefined, null, '', '   ']) {
    assert.equal(buildHypothesisCandidate({ rule: 'X', target: 'a', gerekce: 'g' }, id).candidateId,
      buildHypothesisCandidate({ rule: 'X', target: 'a', gerekce: 'g' }, 'default').candidateId);
  }
});

test('#4032 isRecordInWorkspace keeps a malformed stored record out of every workspace', () => {
  assert.equal(isRecordInWorkspace(undefined, 'default'), true);
  assert.equal(isRecordInWorkspace('  tenant-a ', 'tenant-a'), true);
  assert.equal(isRecordInWorkspace('tenant-a', 'default'), false);
  for (const id of [...NON_STRING_IDS, TOO_LONG_ID]) {
    assert.equal(isRecordInWorkspace(id, 'default'), false, `${JSON.stringify(id).slice(0, 20)} must not land in default`);
  }
});

test('#4032 generateHypotheses does not read a node with a non-string workspace id into default', () => {
  const nodes = [
    { id: 'kept', workspaceId: 'default' },
    { id: 'malformed', workspaceId: 42 },
  ];
  const report = generateHypotheses(graphOf(nodes, []), { workspaceId: 'default' });
  const named = JSON.stringify(report);
  assert.ok(named.includes('kept'), 'the well-formed default node is still read');
  assert.ok(!named.includes('malformed'), 'the malformed node must not be read into default');
});

test('#4032 buildFitnessReport does not count an edge with a non-string workspace id as default', () => {
  const nodes = [{ id: 'a', workspaceId: 'default' }, { id: 'b', workspaceId: 'default' }];
  const malformed = { from: 'a', to: 'b', relation: 'neden', workspaceId: 42, confidence: 0.9 };
  const clean = buildFitnessReport(kernelOf(graphOf(nodes, [])), { workspaceId: 'default' });
  const withMalformed = buildFitnessReport(kernelOf(graphOf(nodes, [malformed])), { workspaceId: 'default' });
  assert.deepEqual(withMalformed.components, clean.components);
});

test('#4032 an approval request with an invalid workspace id fails validation instead of landing in a tenant', () => {
  const base = {
    agentId: 'agent', actor: 'actor', owner: 'owner', actionType: 'write', toolName: 'tool',
    reason: 'r', provenanceId: 'p', trustPolicyVersion: 'v1', actionPayload: { a: 1 },
  };
  for (const id of [...NON_STRING_IDS, TOO_LONG_ID]) {
    const result = buildApprovalRequest({ ...base, workspaceId: id });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === 'workspaceId' && e.code === WORKSPACE_ID_INVALID));
    assert.notEqual(result.request.workspaceId, 'default');
  }
  for (const id of [0, false, NaN]) {
    const result = buildApprovalRequest(base, { workspaceId: id });
    assert.equal(result.ok, false, `opts.workspaceId ${String(id)} must not fall through to default`);
    assert.ok(result.errors.some(e => e.field === 'workspaceId' && e.code === WORKSPACE_ID_INVALID));
  }
  assert.equal(buildApprovalRequest(base).request.workspaceId, 'default');
  assert.equal(buildApprovalRequest({ ...base, workspaceId: 'tenant-a' }, { workspaceId: '' }).request.workspaceId, 'tenant-a');
  assert.equal(buildApprovalRequest({ ...base, workspaceId: ' tenant-a ' }).request.workspaceId, 'tenant-a');
});

test('#4032 huqan.self-evolve answers an id the canonical rule rejects as INVALID_INPUT, not an internal error', () => {
  for (const id of [TOO_LONG_ID, 42, 'a\u0001b'.repeat(50)]) {
    const envelope = executeMcpSelfEvolve(kernelOf(), 'huqan.self-evolve', { workspaceId: id }, null);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'INVALID_INPUT');
    assert.equal(envelope.data, null, 'a refused call must not run the adapter');
  }
});

test('#4032 through the MCP server an over-long workspace id is INVALID_INPUT, not INTERNAL_ERROR', () => {
  // The dispatcher's emergency-stop check applies the canonical rule before any
  // tool runs; a rejected id used to surface as an opaque internal error.
  const { createServer } = require('../mcpServer');
  const Kernel = require('../kernel');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4032-mcp-'));
  const kernel = new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false, memoryPath: path.join(dir, 'k.json') });
  const server = createServer({ kernel, operatorToken: 'test-operator' });
  try {
    const response = server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'huqan.self-evolve', arguments: { workspaceId: TOO_LONG_ID } },
    });
    const envelope = response.result.structuredContent || JSON.parse(response.result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'INVALID_INPUT');
  } finally {
    // createServer opens the approval store and the experience journal beside
    // the injected kernel's memoryPath, and the kernel's own graph may open a
    // handle there too. Windows refuses to unlink a file another handle still
    // holds, so every handle is released before the temp dir is removed.
    server.close();
    kernel.graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#4032 a stop check that fails for a reason other than the id is not swallowed', () => {
  // Only a TypeError is the canonical rule rejecting the id; any other failure
  // is internal and must reach the caller unchanged instead of being reported
  // as an invalid workspace id.
  const { createMcpToolDispatch } = require('../lib/mcp/tool-dispatch');
  const { callTool } = createMcpToolDispatch({ withTransientAgent: async () => ({}) });
  const failure = new Error('the stop ledger could not be read');
  assert.throws(
    () => callTool({}, { name: 'huqan.self-evolve', arguments: {} },
      { emergencyStop: { check() { throw failure; } } }),
    (error) => error === failure,
  );
});
