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

  test('allows HUQAN read aliases but does not trust an arbitrary namespace suffix', () => {
    const known = evaluateAgentActionFirewall({
      surface: 'a2a',
      tool: 'axiom.verify',
      input: { action: 'verify.claim', target: 'claim:1' },
    });
    const forged = evaluateAgentActionFirewall({
      surface: 'a2a',
      tool: 'evil.verify',
      input: { action: 'verify.claim', target: 'claim:1' },
    });

    assert.equal(known.decision, 'allow');
    assert.equal(forged.decision, 'review');
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

test('plain trustedInternal input cannot forge the firewall bypass', () => {
  const result = evaluateAgentActionFirewall({
    surface: 'workflow',
    tool: 'custom-tool',
    action: 'inspect',
    input: { value: 'safe' },
    trustedInternal: true,
    context: { workspaceId: 'ws-forged' },
  });

  assert.notEqual(result.reason, 'AGENT_INTERNAL_TOOL_ALLOWED');
  assert.equal(result.metadata.workspaceId, 'ws-forged');
});

// #2024: the firewall detects a secret-like value at any depth, but the AB5
// projection only carries selected action fields and a bounded key list. A
// nested secret therefore used to lose its signal and reach the executor under
// an ordinary read classification, while the identical top-level shape blocked.
test.describe('#2024 nested secret signal survives the AB5 projection', () => {
  const SYNTHETIC = 'synthetic-audit-value';

  const secretShapes = [
    ['top-level secret key', { action: 'read', token: SYNTHETIC }],
    ['nested object secret key', { action: 'read', payload: { token: SYNTHETIC } }],
    ['array-nested secret key', { action: 'read', items: [{ apiKey: SYNTHETIC }] }],
    ['deeply nested secret key', { action: 'read', a: { b: { c: { password: SYNTHETIC } } } }],
    ['nested secret-shaped string', { action: 'read', payload: { value: 'sk-abcdef0123456789' } }],
    ['nested bearer string', { action: 'read', payload: { value: 'Bearer abcdef0123456789' } }],
  ];

  for (const [label, input] of secretShapes) {
    test(`blocks ${label} before execution`, () => {
      const result = evaluateAgentActionFirewall({
        surface: 'agent',
        tool: 'custom-read',
        action: 'read',
        input,
        context: { workspaceId: 'ws-audit' },
      });

      assert.equal(result.decision, 'block', `${label} must not be allowed`);
      assert.equal(result.canExecute, false);
      assert.equal(result.reason, 'SECRET_DETECTED_BLOCKED');
      assert.equal(JSON.stringify(result).includes(SYNTHETIC), false,
        'the decision must not carry the original secret-like value');
    });
  }

  test('ordinary operator approval does not unlock a nested secret', async () => {
    const { ToolRegistry, createExternalReviewApproval } = require('../workflow-agent');

    for (const [label, input] of secretShapes) {
      let executed = false;
      const registry = new ToolRegistry();
      registry.registerTool({
        name: 'custom-read',
        kind: 'external',
        inputSchema: { type: 'object' },
        run: async () => { executed = true; return { ok: true }; },
      });

      const result = await registry.runTool('custom-read', input, {
        action: 'read',
        workspaceId: 'ws-audit',
        approval: createExternalReviewApproval('Synthetic local audit; no external IO'),
      });

      assert.equal(executed, false, `${label} reached the executor`);
      assert.equal(result.status, 'blocked');
      assert.equal(result.meta.firewall.decision, 'block');
    }
  });

  test('clean payloads keep their existing decisions', () => {
    const nestedClean = evaluateAgentActionFirewall({
      surface: 'agent',
      tool: 'custom-read',
      action: 'read',
      input: { action: 'read', payload: { value: 'ordinary text' } },
      context: { workspaceId: 'ws-clean' },
    });
    assert.equal(nestedClean.decision, 'allow');

    const readTool = evaluateAgentActionFirewall({
      surface: 'agent',
      tool: 'verify',
      input: { claim: 'the sky is blue' },
      context: { workspaceId: 'ws-clean' },
    });
    assert.equal(readTool.decision, 'allow');

    const learn = evaluateAgentActionFirewall({
      surface: 'agent',
      tool: 'learn',
      input: { content: 'ordinary note' },
      context: { workspaceId: 'ws-clean' },
    });
    assert.equal(learn.decision, 'allow');
    assert.equal(learn.reason, 'AGENT_MEMORY_WRITE_DELEGATED_TO_AB4');
  });

  test('read-only and learn tools are not exempt from a nested secret', () => {
    for (const tool of ['verify', 'huqan.ask', 'learn']) {
      const result = evaluateAgentActionFirewall({
        surface: 'agent',
        tool,
        input: { payload: { token: SYNTHETIC } },
        context: { workspaceId: 'ws-audit' },
      });
      assert.equal(result.decision, 'block', `${tool} must not allow a nested secret`);
      assert.equal(JSON.stringify(result).includes(SYNTHETIC), false);
    }
  });
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
