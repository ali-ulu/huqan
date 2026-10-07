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
  bindReviewedCall,
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

test('legacy names still resolve, and a 128-character name is only unknown', () => {
  const kernel = recordingKernel();
  assert.equal(callTool(kernel, { name: 'axiom.ask', arguments: { question: 'kedi nedir' } }).ok, true);
  assert.equal(kernel.calls.length, 1);
  const long = callTool(recordingKernel(), { name: `huqan.${'x'.repeat(122)}`, arguments: {} });
  assert.equal(long.gate.reason, 'unknown_tool_blocked');
});

test('a refused name is recorded for incident review, escaped and bounded', () => {
  const decisions = [];
  const kernel = { ...recordingKernel(), observability: { recordGateDecision: event => decisions.push(event) } };
  callTool(kernel, { name: `huqan.ask\u0000${'y'.repeat(300)}`, arguments: {} });
  const refused = decisions.filter(event => event.reason === 'invalid_tool_name');
  assert.equal(refused.length, 1);
  const { rejectedName } = refused[0].payload.metadata;
  assert.ok(rejectedName.startsWith('"huqan.ask\\u0000y'), 'the control character is escaped');
  assert.ok(!rejectedName.includes('\u0000'), 'no raw control character is recorded');
  assert.ok(rejectedName.length <= 161, 'the name is bounded');
});

test('arguments with no canonical JSON form are blocked, not thrown', () => {
  const kernel = recordingKernel();
  const result = callTool(kernel, { name: 'huqan.ask', arguments: { question: 'kedi', n: 10n } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ARGS_NOT_CANONICAL');
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
  const { reviewedBinding } = saved[0].policy;
  assert.deepEqual(reviewedBinding, bindReviewedCall('huqan.learn', saved[0].context.args, { inputIsArgs: true }));
  assert.ok(bindingHolds(reviewedBinding, 'huqan.learn', JSON.parse(saved[0].input)));
  assert.equal(bindingHolds(reviewedBinding, 'huqan.learn', sent), false);
});

const REVIEWED = { text: 'kedi hayvandir', skipConflicts: true, workspaceId: 'default' };

function approvalRow({ args = REVIEWED, input = JSON.stringify(args), reviewedBinding } = {}) {
  return {
    id: 'appr-1',
    tool: 'huqan.learn',
    input,
    status: 'pending',
    workspaceId: 'default',
    policy: { gate: { decision: 'review' }, ...(reviewedBinding ? { reviewedBinding } : {}) },
    context: { source: 'mcp', workspaceId: 'default', args },
  };
}

const LEARN_BINDING = bindReviewedCall('huqan.learn', REVIEWED, { inputIsArgs: true });

function decide(row) {
  const touched = [];
  const approvalStore = new Proxy({ getToolApprovalById: () => row }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then') return undefined;
      return () => { touched.push(String(key)); return null; };
    },
  });
  const fail = (code, message, meta = {}) => ({ ok: false, error: { code, message }, meta });
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const result = handle({}, { approvalId: 'appr-1', workspaceId: 'default', decision: 'approved' }, { approvalStore });
  return { result, touched };
}

test('an approval whose arguments drifted from the reviewed ones is not executed', () => {
  const drifted = { ...REVIEWED, text: 'kedi zehirlidir' };
  const rows = {
    'both columns rewritten': approvalRow({ args: drifted, reviewedBinding: LEARN_BINDING }),
    'context.args only': approvalRow({ args: drifted, input: JSON.stringify(REVIEWED), reviewedBinding: LEARN_BINDING }),
    'input only': approvalRow({ args: REVIEWED, input: JSON.stringify(drifted), reviewedBinding: LEARN_BINDING }),
    'input unreadable': approvalRow({ args: REVIEWED, input: 'not json', reviewedBinding: LEARN_BINDING }),
  };
  for (const [label, row] of Object.entries(rows)) {
    const { result, touched } = decide(row);
    assert.equal(result.error.code, 'APPROVAL_BINDING_MISMATCH', label);
    assert.equal(result.meta.retrySafe, false, label);
    // The stuck-claim sweep runs before every decision; it is not this row's execution.
    assert.deepEqual(touched.filter(name => name !== 'recoverStuckLeaselessToolApprovals'), [], `${label}: no store write`);
  }
});

test('an intact row, a pre-binding row and a stripped binding pass this check', () => {
  // The stripped case is the documented limit: the digest lives in the same
  // row, so it is a consistency check, not a seal (lib/mcp-call-binding.js).
  for (const row of [approvalRow({ reviewedBinding: LEARN_BINDING }), approvalRow()]) {
    assert.notEqual(decide(row).result?.error?.code, 'APPROVAL_BINDING_MISMATCH');
  }
});

test('a repair approval binds the arguments it will resume with', () => {
  const repairArgs = { goal: 'kedi', workspaceId: 'default', checkpointId: 'ck-1', resumeToken: 'ck-1' };
  const binding = bindReviewedCall('huqan.agent_repair', repairArgs);
  assert.equal(binding.inputIsArgs, false, 'a repair row input is a label');
  const row = {
    id: 'appr-1', tool: 'huqan.agent_repair', input: 'kedi :: repair step-1', status: 'pending', workspaceId: 'default',
    policy: { action: 'review', reviewedBinding: binding },
    context: { workspaceId: 'default', args: { ...repairArgs, checkpointId: 'ck-other' } },
  };
  assert.equal(decide(row).result.error.code, 'APPROVAL_BINDING_MISMATCH');
  assert.notEqual(decide({ ...row, context: { workspaceId: 'default', args: repairArgs } }).result?.error?.code, 'APPROVAL_BINDING_MISMATCH');
});

test('a proposed repair is queued with the binding of the arguments it will resume with', () => {
  const { proposeRepair } = require('../lib/experience/run-repair');
  const saved = [];
  const agent = { storage: { saveToolApproval: (approval) => { saved.push(approval); return { id: 'appr-r1' }; } } };
  const state = { goal: 'kedi hayvandir mi', workspaceId: 'w1', checkpointId: 'ck-7', runId: 'run-1' };
  const report = { status: 'error', result: { error: { message: 'fetch failed: ETIMEDOUT' } } };
  proposeRepair({ agent, state, step: { id: 'verify' }, report });
  assert.equal(saved.length, 1);
  const { reviewedBinding } = saved[0].policy;
  assert.deepEqual(reviewedBinding, bindReviewedCall('huqan.agent_repair', saved[0].context.args));
  assert.deepEqual(saved[0].context.args, { goal: 'kedi hayvandir mi', workspaceId: 'w1', checkpointId: 'ck-7', resumeToken: 'ck-7' });
});
