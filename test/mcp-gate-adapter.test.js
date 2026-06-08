'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MCP_GATE_ADAPTER_VERSION,
  MCP_TOOL_CLASSIFICATIONS,
  MCP_GATE_DECISIONS,
  MCP_GATE_REASONS,
  normalizeMcpToolInput,
  classifyMcpTool,
  mergeMcpDecisions,
  evaluateMcpGate,
} = require('../lib/mcp-gate-adapter');

// ─── normalizeMcpToolInput ────────────────────────────────────────────────────

test('normalizeMcpToolInput: null returns malformed', () => {
  const r = normalizeMcpToolInput(null);
  assert.equal(r.malformed, true);
  assert.equal(r.tool, null);
});

test('normalizeMcpToolInput: string returns malformed', () => {
  const r = normalizeMcpToolInput('bad');
  assert.equal(r.malformed, true);
});

test('normalizeMcpToolInput: missing tool returns malformed', () => {
  const r = normalizeMcpToolInput({ args: {} });
  assert.equal(r.malformed, true);
  assert.equal(r.tool, null);
});

test('normalizeMcpToolInput: valid input with tool only', () => {
  const r = normalizeMcpToolInput({ tool: 'axiom.ask' });
  assert.equal(r.malformed, false);
  assert.equal(r.tool, 'axiom.ask');
  assert.deepEqual(r.args, {});
  assert.deepEqual(r.metadata, {});
});

test('normalizeMcpToolInput: strips whitespace from tool name', () => {
  const r = normalizeMcpToolInput({ tool: '  axiom.ask  ' });
  assert.equal(r.tool, 'axiom.ask');
});

test('normalizeMcpToolInput: non-object args defaults to {}', () => {
  const r = normalizeMcpToolInput({ tool: 'axiom.ask', args: 'bad' });
  assert.deepEqual(r.args, {});
});

test('normalizeMcpToolInput: non-object metadata defaults to {}', () => {
  const r = normalizeMcpToolInput({ tool: 'axiom.ask', metadata: 'bad' });
  assert.deepEqual(r.metadata, {});
});

test('normalizeMcpToolInput: passes args and metadata through', () => {
  const args = { query: 'hello' };
  const metadata = { actor: 'user' };
  const r = normalizeMcpToolInput({ tool: 'axiom.ask', args, metadata });
  assert.deepEqual(r.args, args);
  assert.deepEqual(r.metadata, metadata);
});

// ─── classifyMcpTool ──────────────────────────────────────────────────────────

test('classifyMcpTool: known read-only tool', () => {
  const c = classifyMcpTool('axiom.ask');
  assert.equal(c.known, true);
  assert.equal(c.mutating, false);
  assert.equal(c.category, 'read');
  assert.equal(c.alphaDecision, 'allow');
  assert.deepEqual(c.gates, ['AB1']);
});

test('classifyMcpTool: known mutating tool', () => {
  const c = classifyMcpTool('axiom.learn');
  assert.equal(c.known, true);
  assert.equal(c.mutating, true);
  assert.equal(c.category, 'write');
  assert.equal(c.alphaDecision, 'review');
  assert.deepEqual(c.gates, ['AB1', 'AB2', 'AB4']);
});

test('classifyMcpTool: known agent-loop tool', () => {
  const c = classifyMcpTool('axiom.agent');
  assert.equal(c.known, true);
  assert.equal(c.mutating, false);
  assert.equal(c.category, 'agent-loop');
  assert.equal(c.alphaDecision, 'dry_run_only');
  assert.deepEqual(c.gates, ['AB1', 'AB2']);
});

test('classifyMcpTool: unknown tool returns block', () => {
  const c = classifyMcpTool('axiom未知');
  assert.equal(c.known, false);
  assert.equal(c.mutating, true);
  assert.equal(c.alphaDecision, 'block');
  assert.deepEqual(c.gates, ['AB1', 'AB2']);
});

// ─── mergeMcpDecisions ────────────────────────────────────────────────────────

test('mergeMcpDecisions: allow + allow = allow', () => {
  assert.equal(mergeMcpDecisions('allow', 'allow'), 'allow');
});

test('mergeMcpDecisions: allow + review = review', () => {
  assert.equal(mergeMcpDecisions('allow', 'review'), 'review');
});

test('mergeMcpDecisions: review + block = block', () => {
  assert.equal(mergeMcpDecisions('review', 'block'), 'block');
});

test('mergeMcpDecisions: block + allow = block', () => {
  assert.equal(mergeMcpDecisions('block', 'allow'), 'block');
});

test('mergeMcpDecisions: allow + dry_run_only = dry_run_only', () => {
  assert.equal(mergeMcpDecisions('allow', 'dry_run_only'), 'dry_run_only');
});

test('mergeMcpDecisions: dry_run_only + review = dry_run_only', () => {
  assert.equal(mergeMcpDecisions('dry_run_only', 'review'), 'dry_run_only');
});

test('mergeMcpDecisions: review + dry_run_only = dry_run_only', () => {
  assert.equal(mergeMcpDecisions('review', 'dry_run_only'), 'dry_run_only');
});

test('mergeMcpDecisions: block + review = block', () => {
  assert.equal(mergeMcpDecisions('block', 'review'), 'block');
});

// ─── evaluateMcpGate: malformed input ──────────────────────────────────────────

test('evaluateMcpGate: malformed input blocks', () => {
  const r = evaluateMcpGate(null);
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.MALFORMED_INPUT);
  assert.equal(r.allowed, false);
  assert.equal(r.canExecute, false);
  assert.equal(r.ok, true);
});

test('evaluateMcpGate: string input blocks', () => {
  const r = evaluateMcpGate('bad');
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
});

// ─── evaluateMcpGate: unknown tool ─────────────────────────────────────────────

test('evaluateMcpGate: unknown tool blocks', () => {
  const r = evaluateMcpGate({ tool: 'axiom未知tool' });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.UNKNOWN_TOOL_BLOCK);
  assert.equal(r.allowed, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].known, false);
  assert.equal(r.warnings.length, 1);
});

// ─── evaluateMcpGate: read-only tools (allow) ─────────────────────────────────

const readOnlyTools = [
  'axiom.ask', 'axiom.verify', 'axiom.plan', 'axiom.policy',
  'axiom.approvals', 'axiom.reason', 'axiom.compare', 'axiom.dream',
];

for (const tool of readOnlyTools) {
  test(`evaluateMcpGate: ${tool} → allow`, () => {
    const r = evaluateMcpGate({ tool, args: { query: 'test' } });
    assert.equal(r.ok, true);
    assert.equal(r.allowed, true);
    assert.equal(r.canExecute, true);
    assert.equal(r.decision, MCP_GATE_DECISIONS.allow);
    assert.equal(r.reason, MCP_GATE_REASONS.READ_ONLY_ALLOW);
    assert.equal(r.metadata.tool, tool);
    assert.equal(r.metadata.known, true);
    assert.equal(r.metadata.mutating, false);
  });
}

// ─── evaluateMcpGate: axiom.learn (review) ────────────────────────────────────

test('evaluateMcpGate: axiom.learn → review', () => {
  const r = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'hello' } });
  assert.equal(r.ok, true);
  assert.equal(r.allowed, false);
  assert.equal(r.decision, MCP_GATE_DECISIONS.review);
  assert.equal(r.metadata.tool, 'axiom.learn');
  assert.equal(r.metadata.mutating, true);
  assert.ok(r.findings.length >= 2);
});

test('evaluateMcpGate: axiom.learn with empty args → review', () => {
  const r = evaluateMcpGate({ tool: 'axiom.learn', args: {} });
  assert.equal(r.decision, MCP_GATE_DECISIONS.review);
});

test('evaluateMcpGate: axiom.learn no args → review', () => {
  const r = evaluateMcpGate({ tool: 'axiom.learn' });
  assert.equal(r.decision, MCP_GATE_DECISIONS.review);
});

// ─── evaluateMcpGate: axiom.agent (dry_run_only) ─────────────────────────────

test('evaluateMcpGate: axiom.agent → dry_run_only', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { prompt: 'test' } });
  assert.equal(r.ok, true);
  assert.equal(r.allowed, false);
  assert.equal(r.canDryRun, true);
  assert.equal(r.decision, MCP_GATE_DECISIONS.dry_run_only);
  assert.equal(r.reason, MCP_GATE_REASONS.AGENT_LOOP_DRY_RUN);
  assert.equal(r.metadata.tool, 'axiom.agent');
  assert.ok(r.findings.length >= 1);
});

// ─── evaluateMcpGate: all 10 tools are classified ─────────────────────────────

test('evaluateMcpGate: all 10 MCP tools produce valid decisions', () => {
  const tools = Object.keys(MCP_TOOL_CLASSIFICATIONS);
  assert.equal(tools.length, 10, 'Expected exactly 10 MCP tools');

  for (const tool of tools) {
    const r = evaluateMcpGate({ tool, args: {} });
    assert.equal(r.ok, true, `${tool}: ok should be true`);
    assert.ok(
      Object.values(MCP_GATE_DECISIONS).includes(r.decision),
      `${tool}: decision "${r.decision}" should be a valid MCP gate decision`
    );
    assert.ok(r.metadata, `${tool}: metadata should exist`);
    assert.equal(r.metadata.adapterVersion, MCP_GATE_ADAPTER_VERSION, `${tool}: adapterVersion mismatch`);
  }
});

// ─── evaluateMcpGate: metadata passthrough ─────────────────────────────────────

test('evaluateMcpGate: metadata is passed through', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.ask',
    args: {},
    metadata: { actor: 'user', branch: 'main' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.allowed, true);
});

// ─── evaluateMcpGate: adapter version constant ────────────────────────────────

test('MCP_GATE_ADAPTER_VERSION is defined', () => {
  assert.equal(typeof MCP_GATE_ADAPTER_VERSION, 'string');
  assert.ok(MCP_GATE_ADAPTER_VERSION.length > 0);
});

// ─── evaluateMcpGate: finding structure ────────────────────────────────────────

test('evaluateMcpGate: findings array contains gate results', () => {
  const r = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'x' } });
  assert.ok(Array.isArray(r.findings));
  const gates = r.findings.map(f => f.gate);
  assert.ok(gates.includes('AB1'), 'Should include AB1 finding');
  assert.ok(gates.includes('AB2'), 'Should include AB2 finding');
  assert.ok(gates.includes('AB4'), 'Should include AB4 finding');
});

test('evaluateMcpGate: read-only tool findings only have AB1', () => {
  const r = evaluateMcpGate({ tool: 'axiom.ask', args: {} });
  const gates = r.findings.map(f => f.gate);
  assert.ok(gates.includes('AB1'), 'Should include AB1 finding');
  assert.ok(!gates.includes('AB2'), 'Should NOT include AB2 finding');
  assert.ok(!gates.includes('AB4'), 'Should NOT include AB4 finding');
});
