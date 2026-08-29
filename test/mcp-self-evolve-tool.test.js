'use strict';

/**
 * huqan.self-evolve is the MCP entry point for the self-evolution run that
 * lib/self-evolve-adapter.js composes. The adapter itself is covered by
 * test/self-evolve-adapter.test.js; what is asserted here is only the wiring
 * the adapter could not assert about itself:
 *
 * - the tool is advertised under its canonical name and reachable through the
 *   legacy alias, matching the RFC-001 reader/writer split;
 * - it is gated exactly like huqan.fractal-learn -- a mutating call is held for
 *   review and a durable approval is written, rather than executing;
 * - when review is disabled the dispatch actually runs and returns both halves
 *   of the envelope, so "wired" means "executes", not merely "listed".
 *
 * The last point is the one worth a test: a tool can be advertised, classified
 * and aliased correctly and still dispatch to nothing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { createServer } = require('../mcpServer');
const Kernel = require('../kernel');
const { MCP_TOOL_CLASSIFICATIONS } = require('../lib/mcp-gate-adapter');
const { workflowForMcpTool } = require('../lib/workflow-contract');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-self-evolve-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

let seq = 0;
function seededKernel() {
  seq += 1;
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${seq}.json`),
  });
  for (const sentence of ['kedi memelidir', 'köpek memelidir', 'memeli hayvandır', 'hayvan canlıdır']) {
    kernel.learn(sentence, { bypassAdmission: true });
  }
  return kernel;
}

function callTool(server, name, args) {
  const response = server.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  return response.result.structuredContent || JSON.parse(response.result.content[0].text);
}

test('huqan.self-evolve is advertised under the canonical name only', () => {
  const server = createServer({ kernel: seededKernel(), operatorToken: 'test-operator' });
  const listed = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = listed.result.tools.map(tool => tool.name);

  assert.ok(names.includes('huqan.self-evolve'), 'tools/list must advertise huqan.self-evolve');
  assert.ok(!names.includes('axiom.self-evolve'), 'tools/list must never advertise the legacy alias');

  const advertised = listed.result.tools.find(tool => tool.name === 'huqan.self-evolve');
  assert.equal(advertised.annotations.readOnlyHint, false, 'a self-evolution run is not read-only');
  assert.equal(workflowForMcpTool('huqan.self-evolve').workflowId, 'self-evolve');
});

test('huqan.self-evolve is classified as mutating and held for review', () => {
  const classification = MCP_TOOL_CLASSIFICATIONS['huqan.self-evolve'];
  assert.equal(classification.mutating, true);
  assert.equal(classification.category, 'write');
  assert.equal(classification.alphaDecision, 'review');

  // Same gate shape as fractal-learn: the extra reach is in what the run may
  // change, not in which gate admits it.
  assert.deepEqual(classification.gates, MCP_TOOL_CLASSIFICATIONS['huqan.fractal-learn'].gates);
});

test('a mutating call is held for review instead of executing', () => {
  const server = createServer({ kernel: seededKernel(), operatorToken: 'test-operator' });
  const envelope = callTool(server, 'huqan.self-evolve', { maxRounds: 2, depth: 1 });

  assert.equal(envelope.ok, false, 'an unapproved mutating call must not report success');
  assert.equal(envelope.gate.decision, 'review');
  assert.equal(envelope.gate.reason, 'mutating_requires_review');
  assert.equal(envelope.gate.canExecute, false);
  assert.equal(envelope.approval.tool, 'huqan.self-evolve');
  assert.equal(envelope.approval.status, 'pending');
  assert.equal(envelope.data, undefined, 'a held call must not leak a result');
});

test('the legacy alias resolves to the same handler', () => {
  const server = createServer({ kernel: seededKernel(), operatorToken: 'test-operator' });
  const envelope = callTool(server, 'axiom.self-evolve', { maxRounds: 2, depth: 1 });

  assert.equal(envelope.approval.tool, 'huqan.self-evolve', 'the alias must be canonicalised before the gate sees it');
  assert.equal(envelope.gate.reason, 'mutating_requires_review');
});

test('with review disabled the dispatch runs and returns both halves', () => {
  const previous = process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
  process.env.HUQAN_HUMAN_APPROVAL_DISABLED = 'true';
  try {
    const server = createServer({ kernel: seededKernel(), operatorToken: 'test-operator' });
    const envelope = callTool(server, 'huqan.self-evolve', { maxRounds: 2, depth: 1 });

    assert.equal(envelope.ok, true);
    assert.equal(envelope.type, 'fractal_learn_with_self_evolve');

    // The fractal-learn half: the L4 loop actually ran and terminated on one of
    // its declared stop reasons rather than being skipped.
    assert.ok(['exhausted', 'saturated', 'maxRounds'].includes(envelope.data.fractalLearn.stopReason));
    assert.ok(Array.isArray(envelope.data.fractalLearn.rounds));

    // The self-evolve half: the probe reports a verdict, which is the whole
    // point of routing through the adapter rather than calling FractalLearn.
    assert.ok([
      'native-writes-config', 'native-content-only', 'inactive', 'unmeasured',
    ].includes(envelope.data.selfEvolve.verdict));

    // Bounds are applied by the tool, not trusted from the caller.
    assert.equal(envelope.data.params.maxRounds, 2);
    assert.equal(envelope.data.params.depth, 1);
  } finally {
    if (previous === undefined) delete process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
    else process.env.HUQAN_HUMAN_APPROVAL_DISABLED = previous;
  }
});

test('caller-supplied bounds are clamped, not trusted', () => {
  const previous = process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
  process.env.HUQAN_HUMAN_APPROVAL_DISABLED = 'true';
  try {
    const server = createServer({ kernel: seededKernel(), operatorToken: 'test-operator' });
    const envelope = callTool(server, 'huqan.self-evolve', { maxRounds: 9999, depth: 99 });

    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.params.maxRounds, 20, 'maxRounds must clamp to the advertised maximum');
    assert.equal(envelope.data.params.depth, 5, 'depth must clamp to the advertised maximum');
  } finally {
    if (previous === undefined) delete process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
    else process.env.HUQAN_HUMAN_APPROVAL_DISABLED = previous;
  }
});
