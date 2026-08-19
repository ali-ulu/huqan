'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../agent');
const {
  evaluateAgentActionFirewall,
  AGENT_ACTION_FIREWALL_VERSION,
} = require('../lib/agent-action-firewall');

test.describe('Agent Action Firewall', () => {
  test('allows read-only agent tools without exposing raw input in metadata', () => {
    const result = evaluateAgentActionFirewall({
      surface: 'agent',
      tool: 'ask',
      action: 'ask',
      input: 'Explain the deployment policy.',
      context: { workspaceId: 'ws-read' },
    });

    assert.equal(result.decision, 'allow');
    assert.equal(result.canExecute, true);
    assert.equal(result.metadata.firewallVersion, AGENT_ACTION_FIREWALL_VERSION);
    assert.equal(result.metadata.workspaceId, 'ws-read');
    assert.equal(Object.prototype.hasOwnProperty.call(result.metadata, 'raw'), false);
  });

  test('blocks force-push action before the executor is reached', () => {
    const result = evaluateAgentActionFirewall({
      surface: 'agent',
      tool: 'github',
      action: 'force_push',
      input: { action: 'force_push', target: 'origin/main' },
      context: { workspaceId: 'ws-block' },
    });

    assert.equal(result.decision, 'block');
    assert.equal(result.canExecute, false);
    assert.equal(result.findings[0].category, 'force_push');
  });

  test('keeps merge preview dry-run-only', () => {
    const result = evaluateAgentActionFirewall({
      surface: 'workflow',
      tool: 'github',
      action: 'merge_pr',
      input: { action: 'merge_pr', target: 'org/repo#42', preview: true },
      context: { workspaceId: 'ws-preview' },
      preview: true,
    });

    assert.equal(result.decision, 'dry_run_only');
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
  });

  test('fails closed for malformed requests', () => {
    const result = evaluateAgentActionFirewall({ input: null });
    assert.equal(result.decision, 'block');
    assert.equal(result.canExecute, false);
  });

  test('legacy agent never calls executor for a structured blocked action', () => {
    let executed = false;
    const kernel = {
      learn() {
        executed = true;
        return { ok: true, type: 'learn', data: { added: 1 }, evidence: [] };
      },
      _ok(type, data, evidence, meta) { return { ok: true, type, data, evidence, meta }; },
      _fail(type, code, message, meta) { return { ok: false, type, data: null, evidence: [], error: { code, message }, meta }; },
    };
    const agent = new Agent({ kernel });
    const report = agent._executeStep({
      id: 'step-1',
      action: 'force_push',
      tool: 'learn',
      input: { action: 'force_push', target: 'origin/main' },
    }, { goal: 'test', objective: 'inspect', workspaceId: 'ws-legacy' }, {});

    assert.equal(executed, false);
    assert.equal(report.status, 'blocked');
    assert.equal(report.result.error.code, 'AGENT_ACTION_BLOCKED');
    assert.equal(report.actionFirewall.decision, 'block');
  });
});


test('workflow ToolRegistry blocks a structured external action before run()', async () => {
  const { ToolRegistry } = require('../workflow-agent');
  let executed = false;
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'github',
    kind: 'external',
    description: 'test external tool',
    inputSchema: { type: 'object' },
    run: async () => {
      executed = true;
      return { ok: true, data: { merged: true } };
    },
  });

  const result = await registry.runTool('github', {
    action: 'force_push',
    target: 'origin/main',
  }, { workspaceId: 'ws-workflow', action: 'force_push' });

  assert.equal(executed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'AGENT_ACTION_BLOCKED');
  assert.equal(result.meta.firewall.decision, 'block');
});

test('workflow ToolRegistry preserves firewall evidence for an allowed internal tool', async () => {
  const { ToolRegistry } = require('../workflow-agent');
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'ask',
    kind: 'internal',
    description: 'test read-only tool',
    inputSchema: { type: 'string' },
    run: async () => ({ ok: true, data: { answer: 'ok' } }),
  });

  const result = await registry.runTool('ask', 'What is the current policy?', { workspaceId: 'ws-read' });
  assert.equal(result.status, 'done');
  assert.equal(result.meta.firewall.decision, 'allow');
  assert.equal(result.meta.firewall.metadata.surface, 'workflow');
});


test('package root exposes the same Agent Action Firewall seam', () => {
  const huqan = require('..');
  assert.equal(typeof huqan.evaluateAgentActionFirewall, 'function');
  assert.equal(huqan.AGENT_ACTION_FIREWALL_VERSION, 'AAFW-v1.0.0');
  const decision = huqan.evaluateAgentActionFirewall({
    surface: 'sdk',
    tool: 'github',
    action: 'force_push',
    input: { action: 'force_push', target: 'origin/main' },
  });
  assert.equal(decision.decision, 'block');
});
