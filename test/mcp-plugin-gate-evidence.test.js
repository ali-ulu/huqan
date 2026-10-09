'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');
const PluginManager = require('../plugin');
const { callTool, createServer } = require('../mcpServer');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');
const { applyHumanApprovalToggle } = require('../lib/human-approval-toggle');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');

const input = { tool: 'huqan.ask', args: { question: 'Kedi nedir?' }, metadata: { traceId: 'trace-1' } };

function manager(...hooks) {
  const plugins = new PluginManager({});
  hooks.forEach((hook, i) => plugins.register({ name: `signal-${i}`, beforeGateDecision: hook }));
  return plugins;
}

function evaluate(...hooks) {
  return evaluateMcpGate(input, { plugins: manager(...hooks) });
}

test('MCP call delivers text before the decision and escalates a real ask to review', () => {
  const kernel = new Kernel(isolatedKernelOptions('plugin-gate', { loadPlugins: false }));
  try {
    const baseline = callTool(kernel, { name: input.tool, arguments: input.args });
    assert.equal(baseline.ok, true);
    const order = [];
    let observed;
    let asked = false;
    kernel.plugins.register({
      name: 'risk-signal',
      beforeGateDecision(_kernel, payload) {
        order.push('before');
        assert.deepEqual(payload, { ...input, metadata: {} });
        return { decision: 'review', reason: 'classifier_risk' };
      },
      beforeAsk() { asked = true; },
      afterGateDecision(_kernel, event) { order.push('after'); observed = event; },
    });
    const result = callTool(kernel, { name: 'axiom.ask', arguments: input.args });
    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.equal(result.gate.canExecute, false);
    assert.equal(asked, false);
    assert.deepEqual(order, ['before', 'after']);
    assert.equal(observed.decision, 'review');
    assert.ok(observed.findings.some(f => f.plugin === 'risk-signal' && f.reason === 'classifier_risk'));
  } finally {
    kernel.graph.close?.();
    kernel.memory.close?.();
  }
});

test('each plugin sees original nested args and metadata; mutation cannot change the call', () => {
  const original = { tool: input.tool, args: { ...input.args, nested: { value: 1 } }, metadata: { trace: { id: 1 } } };
  const plugins = manager((_kernel, payload) => {
    payload.tool = 'huqan.learn';
    payload.args.question = 'changed';
    payload.args.nested.value = 2;
    payload.metadata.trace.id = 2;
    return { decision: 'review' };
  }, (_kernel, payload) => {
    assert.deepEqual(payload, original);
    return { decision: 'allow' };
  });
  const result = evaluateMcpGate(original, { plugins });
  assert.equal(result.decision, 'review');
  assert.equal(original.args.nested.value, 1);
  assert.equal(original.metadata.trace.id, 1);
  assert.equal(result.findings.filter(f => f.gate === 'plugin').length, 2);
});

test('plugin signals obey core precedence in either registration order', () => {
  for (const pair of [['review', 'allow'], ['block', 'review'], ['dry_run_only', 'review']]) {
    for (const decisions of [pair, [...pair].reverse()]) {
      const result = evaluate(...decisions.map(decision => () => ({ decision })));
      assert.equal(result.decision, pair[0]);
      assert.equal(result.canExecute, false);
      assert.equal(result.allowed, false);
      assert.equal(result.requiredReview, pair[0] === 'review');
      assert.equal(result.canDryRun, pair[0] !== 'block');
      assert.equal(result.dryRunOnly, pair[0] === 'dry_run_only');
      assert.equal(result.justification.score, result.risk.score);
    }
  }
});

test('allow evidence cannot downgrade core review or block, and cannot spoof verdict fields', () => {
  const plugins = manager(() => ({ decision: 'allow', canExecute: true, findings: [], risk: { score: 0 } }));
  const review = evaluateMcpGate({ tool: 'huqan.learn', args: { text: 'Kedi hayvandır' } }, { plugins });
  assert.equal(review.decision, 'review');
  assert.equal(review.canExecute, false);
  const blockedInput = { tool: 'huqan.learn', args: { text: 'Kedi hayvandır', workspaceId: 'b' }, metadata: { workspaceId: 'a' } };
  const baseline = evaluateMcpGate(blockedInput);
  assert.equal(baseline.decision, 'block');
  assert.equal(evaluateMcpGate(blockedInput, { plugins }).decision, 'block');
});

test('no plugins, no signal and allow signals preserve the existing verdict', () => {
  assert.deepEqual(evaluate(), evaluateMcpGate(input));
  assert.deepEqual(evaluate(() => undefined), evaluateMcpGate(input));
  assert.equal(evaluate(() => ({ decision: 'allow' })).decision, 'allow');
});

test('malformed, throwing and async hooks block without leaking errors or rejected promises', async () => {
  const invalid = [null, false, 'review', [], {}, { decision: 'ALLOW' }, { decision: 'disabled' }, { decision: 'review', reason: {} }];
  const hooks = [
    ...invalid.map(value => () => value),
    () => { throw new Error('private evaluated text'); },
    async () => ({ decision: 'allow' }),
    async () => { throw new Error('private evaluated text'); },
  ];
  for (const hook of hooks) {
    const result = evaluate(hook, () => ({ decision: 'allow' }));
    assert.equal(result.decision, 'block');
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, false);
    assert.equal(result.reason, 'gate_evaluation_error');
    assert.equal(result.risk.score, 100);
    assert.ok(!JSON.stringify(result).includes('private evaluated text'));
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('approval opt-out remains explicit and cannot override plugin blocks', () => {
  const env = { HUQAN_HUMAN_APPROVAL_DISABLED: 'true' };
  const review = applyHumanApprovalToggle(evaluate(() => ({ decision: 'review' })), env);
  assert.equal(review.decision, 'allow');
  assert.equal(review.metadata.originalDecision, 'review');
  assert.equal(applyHumanApprovalToggle(evaluate(() => ({ decision: 'block' })), env).decision, 'block');
});


test('a failing hook blocks a real MCP call before kernel.ask runs', () => {
  const kernel = new Kernel(isolatedKernelOptions('plugin-gate-failure', { loadPlugins: false }));
  try {
    let asked = false;
    kernel.plugins.register({
      name: 'broken-classifier',
      beforeGateDecision() { throw new Error('classifier unavailable'); },
      beforeAsk() { asked = true; },
    });
    const result = callTool(kernel, { name: input.tool, arguments: input.args });
    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'block');
    assert.equal(result.gate.canExecute, false);
    assert.equal(result.gate.reason, 'gate_evaluation_error');
    assert.equal(asked, false);
  } finally {
    kernel.graph.close?.();
    kernel.memory.close?.();
  }
});

test('the hook receives full evaluated text, including content beyond core classifier excerpts', () => {
  const question = 'x'.repeat(1000) + ' risk-marker';
  let received;
  const plugins = manager((_kernel, payload) => {
    received = payload.args.question;
    return { decision: payload.args.question.endsWith('risk-marker') ? 'review' : 'allow' };
  });
  const result = evaluateMcpGate({ ...input, args: { question } }, { plugins });
  assert.equal(received, question);
  assert.equal(result.decision, 'review');
});

test('plugin evidence survives a core gate early block', () => {
  const plugins = manager(() => ({ decision: 'review', reason: 'domain_review_required' }));
  const result = evaluateMcpGate({
    tool: input.tool, args: { ...input.args, workspaceId: 'other' }, metadata: { workspaceId: 'default' },
  }, { plugins });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'ab11_cross_workspace_access_blocked');
  assert.ok(result.findings.some(f => f.plugin === 'signal-0' && f.reason === 'domain_review_required'));
});

test('an explicit plugin dry-run restriction survives agent review restoration and opt-out', () => {
  const plugins = manager(() => ({ decision: 'dry_run_only' }));
  const gate = evaluateMcpGate({ tool: 'huqan.agent', args: { goal: 'summarize' } }, { plugins });
  assert.equal(gate.decision, 'dry_run_only');
  for (const env of [{}, { HUQAN_HUMAN_APPROVAL_DISABLED: 'true' }]) {
    const result = applyHumanApprovalToggle(gate, env);
    assert.equal(result.decision, 'dry_run_only');
    assert.equal(result.canExecute, false);
    assert.equal(result.requiredReview, false);
  }
});

test('JSON-RPC tools/call delivers gate text and never executes a reviewed ask', (t) => {
  const kernel = new Kernel(isolatedKernelOptions('plugin-gate-rpc', { loadPlugins: false }));
  const server = createServer({ kernel, approvalStore: null, operatorCapabilityNonces: new Map() });
  t.after(() => { server.close(); kernel.graph.close?.(); kernel.memory.close?.(); });
  const order = [];
  let received;
  let telemetry;
  kernel.plugins.register({
    name: 'rpc-classifier',
    beforeGateDecision(_kernel, payload) {
      order.push('before');
      received = payload;
      return { decision: 'review', reason: 'domain_review_required' };
    },
    beforeAsk() { order.push('ask'); },
    afterGateDecision(_kernel, event) { order.push('after'); telemetry = event; },
  });
  const response = server.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: input.tool, arguments: input.args },
  });
  assert.deepEqual(received, { ...input, metadata: {} });
  assert.equal(response.result.structuredContent.gate.decision, 'review');
  assert.equal(response.result.structuredContent.gate.canExecute, false);
  assert.deepEqual(order, ['before', 'after']);
  assert.equal(telemetry.decision, 'review');
  assert.equal(JSON.stringify(telemetry).includes(input.args.question), false);
});
