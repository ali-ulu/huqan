'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');
const PluginManager = require('../plugin');
const { callTool } = require('../mcpServer');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const { revalidateApprovedAgent } = require('../lib/mcp-agent-approval-execution');

function manager(...handlers) {
  const plugins = new PluginManager({});
  handlers.forEach((beforeGateDecision, i) => plugins.register({ name: `signal-${i}`, beforeGateDecision }));
  return plugins;
}

const ask = { tool: 'huqan.ask', args: { question: 'A domain-specific question' }, metadata: {} };

test('MCP ingress delivers evaluated text before telemetry and prevents execution on review', () => {
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  const order = [];
  let observed;
  kernel.usePlugin({
    name: 'domain-review',
    beforeGateDecision(_kernel, input) {
      order.push('before');
      assert.deepEqual(input, ask);
      return { decision: 'review' };
    },
    afterGateDecision(_kernel, event) {
      order.push('after');
      observed = event;
      return { decision: 'allow' };
    },
    beforeAsk() { order.push('executed'); },
  });
  const result = callTool(kernel, { name: ask.tool, arguments: ask.args });
  assert.equal(result.gate.decision, 'review');
  assert.equal(result.gate.canExecute, false);
  assert.deepEqual(order, ['before', 'after']);
  assert.equal(observed.decision, 'review');
  assert.ok(observed.findings.some(f => f.plugin === 'domain-review' && f.decision === 'review'));
  assert.equal(JSON.stringify(observed).includes(ask.args.question), false);
});

test('all handlers receive independent original input and later allow cannot erase block', () => {
  const input = { ...ask, args: { question: 'original', nested: { value: 1 } }, metadata: { workspaceId: 'a' } };
  const original = structuredClone(input);
  const plugins = manager(
    (_kernel, data) => {
      data.args.question = 'rewritten';
      data.args.nested.value = 2;
      data.metadata.workspaceId = 'b';
      return { decision: 'block', args: {} };
    },
    (_kernel, data) => {
      assert.deepEqual(data, original);
      return { decision: 'allow', findings: [] };
    },
  );
  const result = evaluateMcpGate(input, { plugins });
  assert.deepEqual(input, original);
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
  assert.deepEqual(result.findings.filter(f => f.plugin).map(f => f.decision), ['block', 'allow']);
});

test('plugin evidence respects every existing MCP precedence pair', () => {
  const labels = ['allow', 'review', 'dry_run_only', 'block'];
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      const plugins = manager(() => ({ decision: labels[i] }), () => ({ decision: labels[j] }));
      const result = evaluateMcpGate(ask, { plugins });
      assert.equal(result.decision, labels[Math.max(i, j)]);
      assert.equal(result.canExecute, result.decision === 'allow');
      assert.equal(result.requiredReview, result.decision === 'review');
      assert.equal(result.dryRunOnly, result.decision === 'dry_run_only');
    }
  }
});

test('allow evidence cannot weaken a core cross-workspace block', () => {
  const result = evaluateMcpGate({
    tool: ask.tool, args: { question: 'test', workspaceId: 'private' },
    metadata: { workspaceId: 'default', workspaceGrants: [] },
  }, { plugins: manager(() => ({ decision: 'allow' })) });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'ab11_cross_workspace_access_blocked');
  assert.ok(result.findings.some(f => f.gate === 'AB11' && f.decision === 'block'));
});

test('no handlers and undefined signals preserve the original gate result', () => {
  const baseline = evaluateMcpGate(ask);
  assert.deepEqual(evaluateMcpGate(ask, { plugins: manager() }), baseline);
  assert.deepEqual(evaluateMcpGate(ask, { plugins: manager(() => undefined) }), baseline);
});

test('invalid, throwing and async handlers fail closed without leaking exception text', async () => {
  const handlers = [
    () => null, () => 'review', () => ({}), () => ({ decision: 'disabled' }),
    () => ({ decision: 'unknown' }), () => [{ decision: 'review' }],
    () => { throw new Error('private evaluated text'); },
    () => Promise.resolve({ decision: 'allow' }),
    async () => { throw new Error('private evaluated text'); },
  ];
  for (const handler of handlers) {
    const result = evaluateMcpGate(ask, { plugins: manager(handler, () => ({ decision: 'allow' })) });
    assert.equal(result.decision, 'block');
    assert.equal(result.reason, 'plugin_gate_evidence_error');
    assert.ok(result.findings.some(f => f.failClosed));
    assert.equal(JSON.stringify(result).includes('private evaluated text'), false);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('MCP aliases deliver the canonical tool and block never executes even with approval disabled', () => {
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  let observed;
  let executed = false;
  kernel.usePlugin({
    name: 'blocker',
    beforeGateDecision(_kernel, input) {
      observed = input;
      return { decision: 'block' };
    },
    beforeAsk() { executed = true; },
  });
  const old = process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
  process.env.HUQAN_HUMAN_APPROVAL_DISABLED = 'true';
  try {
    const result = callTool(kernel, { name: 'axiom.ask', arguments: ask.args });
    assert.equal(result.gate.decision, 'block');
    assert.equal(result.gate.canExecute, false);
    assert.equal(result.ok, false);
    assert.equal(observed.tool, 'huqan.ask');
    assert.equal(observed.args.question, ask.args.question);
    assert.equal(executed, false);
  } finally {
    if (old === undefined) delete process.env.HUQAN_HUMAN_APPROVAL_DISABLED;
    else process.env.HUQAN_HUMAN_APPROVAL_DISABLED = old;
  }
});

test('mutating hook input with no evidence leaves the real ask execution unchanged', () => {
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  let executedQuestion;
  kernel.usePlugin({
    name: 'observer',
    beforeGateDecision(_kernel, input) { input.args.question = 'rewritten'; },
    beforeAsk(_kernel, data) { executedQuestion = data.question; },
  });
  const result = callTool(kernel, { name: ask.tool, arguments: ask.args });
  assert.equal(result.ok, true);
  assert.equal(executedQuestion, ask.args.question);
});

test('a later handler cannot mutate a previously returned signal', () => {
  const signal = { decision: 'block' };
  const plugins = manager(() => signal, () => { signal.decision = 'allow'; });
  assert.equal(evaluateMcpGate(ask, { plugins }).decision, 'block');
});

test('approved-agent revalidation consults current plugin evidence', () => {
  const kernel = { plugins: manager(() => ({ decision: 'block' })) };
  const result = revalidateApprovedAgent({ goal: 'summarize results' }, kernel);
  assert.equal(result.decision, 'block');
  assert.equal(result.canExecute, false);
  assert.ok(result.findings.some(f => f.plugin === 'signal-0' && f.decision === 'block'));
});
