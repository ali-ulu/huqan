'use strict';

// #3488: SEP-986 tool names are refused, not repaired; every gate decision is
// bound to the tool and the digest of the arguments it decided about; the
// interceptor chain cannot change them before the handler runs; and an
// approval executes only the arguments its reviewer saw.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// The interceptor test needs a gate that rewrites its input. The gate is
// read when tool-dispatch loads, so the seam is installed first and stays a
// pass-through unless a test arms it.
const gateAdapter = require('../lib/mcp-gate-adapter');
const realEvaluateMcpGate = gateAdapter.evaluateMcpGate;
let rewriteArgs = null;
gateAdapter.evaluateMcpGate = (input, options) => {
  const decision = realEvaluateMcpGate(input, options);
  if (rewriteArgs) rewriteArgs(input.args);
  return decision;
};

const {
  SEP_986_TOOL_NAME,
  isSep986ToolName,
  namesConform,
  bindCall,
  bindingHolds,
} = require('../lib/mcp-call-binding');
const { CANONICAL_MCP_TOOL_NAMES, LEGACY_MCP_TOOL_NAMES } = require('../lib/mcp-tool-names');
const { WORKFLOW_TOOL_SCHEMAS } = require('../lib/mcp/tool-surface');
const { callTool } = require('../mcpServer');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');

// Pinned SEP-986 conformance vectors.
const VALID_NAMES = ['a', 'huqan.learn', 'huqan.fractal-learn', 'huqan.agent_resume', 'A_b-9.z', 'x'.repeat(128)];
const INVALID_NAMES = [
  '', 'x'.repeat(129), ' huqan.status ', 'huqan.status\u0000', 'huqan.status\n', 'huqan status',
  'huqan/status', 'huqan:status', 'hüqan.status', 'huqan.status​', null, undefined, 42, {}, ['huqan.status'],
];

function recordingKernel() {
  const calls = [];
  const envelope = type => ({ ok: true, type, data: { status: 'verified', confidence: 0.9 }, evidence: [], error: null, meta: {} });
  return {
    calls,
    ask: (...args) => { calls.push(['ask', ...args]); return envelope('ask'); },
    verify: (...args) => { calls.push(['verify', ...args]); return envelope('verify'); },
    reason: (...args) => { calls.push(['reason', ...args]); return envelope('reason'); },
  };
}

test('the SEP-986 rule accepts and refuses the pinned vectors', () => {
  assert.equal(SEP_986_TOOL_NAME.source, '^[A-Za-z0-9._-]{1,128}$');
  for (const name of VALID_NAMES) assert.equal(isSep986ToolName(name), true, JSON.stringify(name));
  for (const name of INVALID_NAMES) assert.equal(isSep986ToolName(name), false, JSON.stringify(name));
});

test('every published and legacy name conforms inside its own namespace', () => {
  assert.ok(namesConform(WORKFLOW_TOOL_SCHEMAS.map(tool => tool.name), ['huqan.']));
  assert.ok(namesConform(CANONICAL_MCP_TOOL_NAMES, ['huqan.']));
  assert.ok(namesConform(LEGACY_MCP_TOOL_NAMES, ['axiom.']));
  assert.equal(namesConform(['huqan.'], ['huqan.']), false, 'the bare namespace is not a tool');
  assert.equal(namesConform(['other.tool'], ['huqan.']), false);
  assert.equal(namesConform(['huqan.bad name'], ['huqan.']), false);
});

test('a catalog name outside the rule stops the tool surface from loading', () => {
  const root = path.join(__dirname, '..');
  const script = `
    const catalog = require(${JSON.stringify(path.join(root, 'lib', 'mcp-tool-catalog.js'))});
    catalog.TOOL_SCHEMAS.push({ name: 'huqan.bad name', inputSchema: {}, outputSchema: {} });
    try { require(${JSON.stringify(path.join(root, 'lib', 'mcp', 'tool-surface.js'))}); process.exit(0); }
    catch (err) { process.stdout.write(err.message); process.exit(3); }`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 3, child.stderr);
  assert.match(child.stdout, /outside SEP-986/);
});

test('a name outside SEP-986 is blocked as malformed and never reaches a handler', () => {
  for (const name of [' huqan.ask ', 'huqan.ask\u0000', 'huqan.ask\n', 'axiom.ask\t']) {
    const kernel = recordingKernel();
    const result = callTool(kernel, { name, arguments: { question: 'kedi nedir' } });
    assert.equal(result.ok, false, JSON.stringify(name));
    assert.equal(result.gate.reason, 'malformed_input_blocked', JSON.stringify(name));
    assert.deepEqual(kernel.calls, [], `${JSON.stringify(name)} ran nothing`);
  }
  const kernel = recordingKernel();
  assert.equal(callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir' } }).ok, true);
  assert.equal(kernel.calls.length, 1);
});

test('a decision is bound to its tool and an order-independent digest of its arguments', () => {
  const binding = bindCall('huqan.learn', { text: 'kedi', skipConflicts: true, provenance: { a: 1, b: 2 } });
  assert.equal(binding.tool, 'huqan.learn');
  assert.match(binding.argsDigest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(binding));
  assert.ok(bindingHolds(binding, 'huqan.learn', { provenance: { b: 2, a: 1 }, skipConflicts: true, text: 'kedi' }));
  assert.equal(bindingHolds(binding, 'huqan.learn', { text: 'kopek', skipConflicts: true, provenance: { a: 1, b: 2 } }), false);
  assert.equal(bindingHolds(binding, 'huqan.ask', { text: 'kedi', skipConflicts: true, provenance: { a: 1, b: 2 } }), false);
  assert.equal(bindingHolds(null, 'huqan.learn', {}), false);
});

test('an interceptor that changes the arguments after the decision runs nothing', (t) => {
  t.after(() => { rewriteArgs = null; });
  rewriteArgs = (args) => { args.question = 'something else'; };
  const kernel = recordingKernel();
  const result = callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi nedir' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CALL_BINDING_BROKEN');
  assert.deepEqual(kernel.calls, []);
});

test('a queued approval stores the binding of the arguments its reviewer sees', () => {
  const saved = [];
  const approvalStore = {
    saveToolApproval: (approval) => { saved.push(approval); return { saved: true, approval }; },
    getToolApprovalById: () => null,
  };
  // Arguments the storage sanitizer changes: the binding must cover what is
  // stored and shown, not what was sent.
  const sent = { text: '  kedi hayvandir\u0007 ', skipConflicts: true, junk: 'dropped' };
  const result = callTool({}, { name: 'huqan.learn', arguments: sent }, { approvalStore });
  assert.equal(result.ok, false);
  assert.equal(saved.length, 1);
  const { binding } = saved[0].policy.gate;
  assert.deepEqual(binding, bindCall('huqan.learn', saved[0].context.args));
  assert.deepEqual(binding, bindCall('huqan.learn', JSON.parse(saved[0].input)));
  assert.notDeepEqual(binding, bindCall('huqan.learn', sent));
});

function approvalRecord({ args, bindingArgs }) {
  return {
    id: 'appr-1',
    tool: 'huqan.learn',
    input: JSON.stringify(args),
    status: 'pending',
    workspaceId: 'default',
    policy: { gate: { decision: 'review', ...(bindingArgs ? { binding: bindCall('huqan.learn', bindingArgs) } : {}) } },
    context: { source: 'mcp', workspaceId: 'default', args },
  };
}

function decide(record) {
  const touched = [];
  const approvalStore = new Proxy({
    getToolApprovalById: () => record,
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then') return undefined;
      return (...args) => { touched.push(String(key)); return null; };
    },
  });
  const fail = (code, message, meta = {}) => ({ ok: false, error: { code, message }, meta });
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const result = handle({}, { approvalId: 'appr-1', workspaceId: 'default', decision: 'approved' }, { approvalStore });
  return { result, touched };
}

test('an approval whose stored arguments no longer match its binding is not executed', () => {
  const reviewed = { text: 'kedi hayvandir', skipConflicts: true, workspaceId: 'default' };
  const tampered = approvalRecord({ args: { ...reviewed, text: 'kedi zehirlidir' }, bindingArgs: reviewed });
  const { result, touched } = decide(tampered);
  assert.equal(result.error.code, 'APPROVAL_BINDING_MISMATCH');
  assert.equal(result.meta.retrySafe, false);
  assert.ok(!touched.some(name => /claim|approve|finaliz/i.test(name)), `nothing was claimed: ${touched}`);

  // An intact binding, and a row written before bindings existed, both pass
  // this check and continue into execution.
  for (const record of [approvalRecord({ args: reviewed, bindingArgs: reviewed }), approvalRecord({ args: reviewed })]) {
    const outcome = decide(record);
    assert.notEqual(outcome.result?.error?.code, 'APPROVAL_BINDING_MISMATCH');
  }
});
