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
  assert.deepEqual(c.gates, ['AB1', 'AB11']);
});

test('classifyMcpTool: known mutating tool', () => {
  const c = classifyMcpTool('axiom.learn');
  assert.equal(c.known, true);
  assert.equal(c.mutating, true);
  assert.equal(c.category, 'write');
  assert.equal(c.alphaDecision, 'review');
  assert.deepEqual(c.gates, ['AB1', 'AB2', 'AB4', 'AB11']);
});

test('classifyMcpTool: prototype names are unknown and fail closed (#1069)', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const classification = classifyMcpTool(name);
    const result = evaluateMcpGate({ tool: name, args: { question: 'q' }, metadata: {} });
    assert.equal(classification.known, false, name);
    assert.equal(result.decision, MCP_GATE_DECISIONS.block, name);
    assert.equal(result.reason, MCP_GATE_REASONS.UNKNOWN_TOOL_BLOCK, name);
  }
});

test('classifyMcpTool: known agent-loop tool', () => {
  const c = classifyMcpTool('axiom.agent');
  assert.equal(c.known, true);
  assert.equal(c.mutating, false);
  assert.equal(c.category, 'agent-loop');
  assert.equal(c.alphaDecision, 'dry_run_only');
  assert.deepEqual(c.gates, ['AB1', 'AB2', 'AB5', 'AB8', 'AB9', 'AB11']);
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

test('evaluateMcpGate: AB4 derives a destructive action from learn args', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.learn',
    args: { text: 'obsolete fact', action: 'delete' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  const ab4 = r.findings.find(f => f.gate === 'AB4');
  assert.equal(ab4.action, 'delete');
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

test('evaluateMcpGate: agent force_push is blocked by AB5 before dry-run fallback', () => {
  const r = evaluateMcpGate({
    tool: 'huqan.agent',
    args: { action: 'force_push', target: 'origin/main', goal: 'force push origin/main' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.AB5_BLOCKED);
  assert.equal(r.canExecute, false);
  assert.ok(r.findings.some(f => f.gate === 'AB5' && f.decision === 'block'));
});

test('evaluateMcpGate: ordinary agent goal remains dry-run-only with AB5 evidence', () => {
  const r = evaluateMcpGate({
    tool: 'huqan.agent',
    args: { goal: 'Summarize the local trust receipt.' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.dry_run_only);
  assert.equal(r.canExecute, false);
  assert.ok(r.findings.some(f => f.gate === 'AB5'));
});

// ─── evaluateMcpGate: every declared tool is classified ──────────────────────

test('evaluateMcpGate: every declared MCP tool produces a valid decision', () => {
  const tools = Object.keys(MCP_TOOL_CLASSIFICATIONS);
  assert.ok(tools.length > 0);
  assert.ok(tools.includes('huqan.advocate'));
  assert.ok(tools.includes('huqan.search'));
  assert.ok(tools.includes('huqan.trust_receipt'));
  assert.ok(tools.includes('huqan.ingest_preview'));

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

// ─── evaluateMcpGate: AB8 command exec ─────────────────────────────────────────

test('evaluateMcpGate: AB8 blocks a denylisted command hidden in an agent goal', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'run rm -rf / to clean up' } });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.AB8_BLOCKED);
  assert.equal(r.allowed, false);
  assert.equal(r.canExecute, false);
  const ab8 = r.findings.find(f => f.gate === 'AB8');
  assert.ok(ab8, 'Should include AB8 finding');
  assert.equal(ab8.decision, 'block');
  assert.equal(ab8.denylistMatch, 'rm_rf_root_or_home');
});

test('evaluateMcpGate: AB8 escalates a goal with shell chaining metacharacters to review', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'echo hi; echo bye' } });
  const ab8 = r.findings.find(f => f.gate === 'AB8');
  assert.ok(ab8, 'Should include AB8 finding');
  assert.equal(ab8.decision, 'review');
  assert.ok(ab8.injectionMatches.includes('command_chain_semicolon'));
  assert.notEqual(r.decision, MCP_GATE_DECISIONS.allow);
});

test('evaluateMcpGate: AB8 finding never echoes the raw command text', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'run rm -rf / to clean up' } });
  assert.equal(JSON.stringify(r).includes('clean up'), false, 'raw command text must not appear in the gate result');
});

// ─── evaluateMcpGate: AB9 data egress ──────────────────────────────────────────

test('evaluateMcpGate: AB9 flags PII in agent-loop args without leaking the matched value', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'email ali@example.com the report' } });
  const ab9 = r.findings.find(f => f.gate === 'AB9');
  assert.ok(ab9, 'Should include AB9 finding');
  assert.equal(ab9.piiDetected, true);
  assert.deepEqual(ab9.piiTypes, ['email']);
  assert.equal(JSON.stringify(r).includes('ali@example.com'), false, 'raw PII value must not appear anywhere in the gate result');
});

test('evaluateMcpGate: AB9 reports no PII/secret for a clean agent-loop goal', () => {
  const r = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'kedi hayvandir mi kontrol et' } });
  const ab9 = r.findings.find(f => f.gate === 'AB9');
  assert.ok(ab9, 'Should include AB9 finding');
  assert.equal(ab9.piiDetected, false);
  assert.equal(ab9.secretDetected, false);
});

// ─── evaluateMcpGate: AB11 cross-workspace access ─────────────────────────────

test('evaluateMcpGate: AB11 blocks a tool call that reaches into another workspace', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.ask',
    args: { query: 'test', workspaceId: 'ws-b', operation: 'read' },
    metadata: { workspaceId: 'ws-a' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_BLOCKED);
  const ab11 = r.findings.find(f => f.gate === 'AB11');
  assert.ok(ab11);
  assert.equal(ab11.crossWorkspace, true);
});

test('evaluateMcpGate: AB11 allows a call that stays inside its own workspace', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.ask',
    args: { query: 'test', workspaceId: 'ws-a', operation: 'read' },
    metadata: { workspaceId: 'ws-a' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.allow);
  const ab11 = r.findings.find(f => f.gate === 'AB11');
  assert.equal(ab11.crossWorkspace, false);
});

test('evaluateMcpGate: AB11 escalates a granted cross-workspace write to review', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.ask',
    args: { query: 'test', workspaceId: 'ws-b', operation: 'update' },
    metadata: {
      workspaceId: 'ws-a',
      workspaceGrants: [{ fromWorkspaceId: 'ws-a', toWorkspaceId: 'ws-b', operations: ['write'] }],
    },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.review);
  assert.equal(r.reason, MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_REVIEW);
});

test('evaluateMcpGate: AB11 stays out of the way when no workspace is declared', () => {
  const r = evaluateMcpGate({ tool: 'axiom.ask', args: { query: 'test' } });
  assert.equal(r.decision, MCP_GATE_DECISIONS.allow,
    'a call that declares no workspace is not making a cross-workspace claim');
  assert.equal(r.findings.some(f => f.gate === 'AB11'), false,
    'AB11 should record nothing when it has nothing to decide');
});

test('evaluateMcpGate: AB11 does not fire when only one side declares a workspace', () => {
  const onlyArgs = evaluateMcpGate({ tool: 'axiom.ask', args: { query: 'x', workspaceId: 'ws-a' } });
  const onlyMeta = evaluateMcpGate({ tool: 'axiom.ask', args: { query: 'x' }, metadata: { workspaceId: 'ws-a' } });
  assert.equal(onlyArgs.decision, MCP_GATE_DECISIONS.allow);
  assert.equal(onlyMeta.decision, MCP_GATE_DECISIONS.allow);
});

test('evaluateMcpGate: AB11 blocks a cross-workspace learn before it can mutate', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.learn',
    args: { text: 'kedi hayvandir', workspaceId: 'ws-b', operation: 'learn' },
    metadata: { workspaceId: 'ws-a' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.allowed, false);
  assert.equal(r.canExecute, false);
});

test('evaluateMcpGate: AB11 uses the learn tool action without inventing a grant', () => {
  const r = evaluateMcpGate({
    tool: 'axiom.learn',
    args: { text: 'kedi hayvandir', workspaceId: 'ws-b' },
    metadata: { workspaceId: 'ws-a' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.AB11_CROSS_WORKSPACE_BLOCKED);
  const ab11 = r.findings.find(f => f.gate === 'AB11');
  assert.equal(ab11.reason, 'cross_workspace_denied');
  assert.equal(ab11.crossWorkspace, true);
});

// ─── #358: gates must fail closed, not fail open, on a thrown error ──────────

test('evaluateMcpGate: a gate that throws blocks the call instead of silently allowing it (#358)', () => {
  // buildAb1Input calls JSON.stringify(args) to build AB1's context; a
  // BigInt anywhere in args -- trivially craftable by any MCP client, not a
  // contrived edge case -- makes that throw a TypeError. Pre-fix, the
  // try/catch around every gate only pushed a warning string and left
  // `decision` untouched, so a read-only tool (whose default is allow)
  // silently reached the caller as an allowed call with the entire AB1
  // check skipped.
  const r = evaluateMcpGate({ tool: 'axiom.ask', args: { text: 10n } });

  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.allowed, false);
  assert.equal(r.canExecute, false);
  assert.equal(r.reason, MCP_GATE_REASONS.GATE_ERROR);
});

test('evaluateMcpGate: a gate throw is recorded in findings, not just as a warning string', () => {
  const r = evaluateMcpGate({ tool: 'axiom.ask', args: { text: 10n } });
  const failure = r.findings.find(f => f.gate === 'AB1');

  assert.ok(failure, 'the gate failure must be visible in findings, not only in warnings');
  assert.equal(failure.decision, MCP_GATE_DECISIONS.block);
  assert.equal(failure.failClosed, true);
  assert.ok(r.warnings.some(w => w.includes('AB1 error')));
});

test('evaluateMcpGate: a later gate cannot downgrade a fail-closed block back to allow', () => {
  // axiom.learn runs AB1, AB2, AB4, AB11 in that order. Forcing AB1 to
  // throw must leave the call blocked even though AB2/AB4/AB11 go on to
  // evaluate normally afterward and might individually return allow/review.
  const r = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 10n } });

  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.allowed, false);
});

test('evaluateMcpGate: a gate throw on a normally-blocked-by-other-means call still blocks (no regression)', () => {
  // Sanity check: an unrelated, definitely-blocking condition (cross-workspace
  // write) combined with an unrelated gate throwing must still block --
  // fail-closed composes with a real block, it does not fight it.
  const r = evaluateMcpGate({
    tool: 'axiom.learn',
    args: { text: 10n, workspaceId: 'ws-b', operation: 'learn' },
    metadata: { workspaceId: 'ws-a' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
});


test('evaluateMcpGate: dangerous action expressed only in agent goal is blocked by AB5', () => {
  const r = evaluateMcpGate({
    tool: 'huqan.agent',
    args: { goal: 'force push origin/main immediately' },
  });
  assert.equal(r.decision, MCP_GATE_DECISIONS.block);
  assert.equal(r.reason, MCP_GATE_REASONS.AB5_BLOCKED);
  assert.ok(r.findings.some(f => f.gate === 'AB5' && f.decision === 'block'));
});
