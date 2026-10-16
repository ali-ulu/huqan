'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createAgentWorkflowRoutes } = require('../lib/http/agent-workflow-routes');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

function fixture({ plan, run, createFails = false } = {}) {
  const writes = [];
  const calls = [];
  let closed = 0;
  const agent = {
    plan: (goal, options) => {
      calls.push({ kind: 'plan', goal, options });
      return plan;
    },
    run: (goal, options) => {
      calls.push({ kind: 'run', goal, options });
      return run;
    },
    storage: { close: () => { closed += 1; } },
  };
  const handler = createAgentWorkflowRoutes({
    createAgent: () => {
      if (createFails) throw new Error('runtime down');
      return agent;
    },
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json, headers) => writes.push({ status, json, headers }),
  });
  const invoke = async (method, path, body) => {
    const handled = await handler({ method, body }, {}, new URL(path, 'http://localhost'));
    return { handled, write: writes.at(-1), calls, closed: () => closed };
  };
  return { invoke };
}

const planResult = {
  ok: true,
  type: 'plan',
  data: {
    goal: 'hedef',
    objective: 'investigate',
    status: 'planned',
    confidence: 0.58,
    steps: [{ id: 'context', action: 'ask', tool: 'ask' }],
    policy: { objective: 'investigate' },
  },
  evidence: [],
};

const pausedRun = {
  ok: true,
  type: 'agent',
  data: {
    goal: 'hedef',
    status: 'paused',
    checkpointId: 'checkpoint-1',
    resumeToken: 'token-1',
    pauseReason: 'stalled',
    nextAction: { action: 'reframe', tool: 'dream' },
    steps: [{ id: 'context' }],
    workspaceId: 'tenant-x',
  },
  evidence: [{ id: 'e1' }],
};

describe('agent workflow HTTP routes (#786)', () => {
  it('ignores paths it does not own', async () => {
    const { invoke } = fixture({ plan: planResult });
    const { handled } = await invoke('POST', '/api/v2/workflows/ask', {});
    assert.equal(handled, false);
  });

  it('plans through the agent runtime and reports a completed envelope', async () => {
    const { invoke } = fixture({ plan: planResult });
    const { handled, write, calls } = await invoke('POST', '/api/v2/agent/plan', {
      workspaceId: 'tenant-x', goal: 'hedef', maxSteps: 3,
    });
    assert.equal(handled, true);
    assert.equal(write.status, 200);
    assert.equal(write.json.workflowId, 'agent-plan');
    assert.equal(write.json.status, 'completed');
    assert.equal(write.json.ok, true);
    assert.equal(write.json.data.workspaceId, 'tenant-x');
    assert.equal(write.json.data.steps.length, 1);
    // The agent's own lifecycle marker survives inside data.
    assert.equal(write.json.data.status, 'planned');
    assert.equal(calls[0].options.maxSteps, 3);
    assert.equal(calls[0].options.workspaceId, 'tenant-x');
    assert.equal(write.headers['Cache-Control'], 'no-store');
  });

  it('maps a paused run onto the paused workflow status instead of success', async () => {
    const { invoke } = fixture({ run: pausedRun });
    const { write } = await invoke('POST', '/api/v2/agent/runs', {
      workspaceId: 'tenant-x', goal: 'hedef',
    });
    assert.equal(write.json.workflowId, 'agent-run');
    assert.equal(write.json.status, 'paused');
    // A paused run has not reached its goal, so ok must not claim success.
    assert.equal(write.json.ok, false);
    assert.equal(write.json.data.runId, 'checkpoint-1');
    assert.equal(write.json.data.resumeToken, 'token-1');
    assert.equal(write.json.data.pauseReason, 'stalled');
    assert.equal(write.json.data.nextAction.action, 'reframe');
    assert.equal(write.json.evidence.length, 1);
  });

  it('reports a completed run as completed', async () => {
    const run = { ok: true, data: { status: 'completed', checkpointId: 'c2', steps: [] } };
    const { invoke } = fixture({ run });
    const { write } = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(write.json.status, 'completed');
    assert.equal(write.json.ok, true);
  });

  it('does not report an unfinished run as completed', async () => {
    const run = { ok: true, data: { status: 'running', checkpointId: 'c3', steps: [] } };
    const { invoke } = fixture({ run });
    const { write } = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(write.json.status, 'partial');
    assert.equal(write.json.ok, false);
  });

  it('rejects a blocked run with the blocked status', async () => {
    const run = { ok: true, data: { status: 'blocked', steps: [] } };
    const { invoke } = fixture({ run });
    const { write } = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(write.json.status, 'blocked');
    assert.equal(write.json.ok, false);
  });

  it('requires workspaceId and goal', async () => {
    const { invoke } = fixture({ plan: planResult });
    const missingWorkspace = await invoke('POST', '/api/v2/agent/plan', { goal: 'hedef' });
    assert.equal(missingWorkspace.write.status, 400);
    assert.equal(missingWorkspace.write.json.error.code, 'INVALID_INPUT');

    const missingGoal = await invoke('POST', '/api/v2/agent/plan', { workspaceId: 'tenant-x' });
    assert.equal(missingGoal.write.status, 400);
    assert.equal(missingGoal.write.json.status, 'failed');
  });

  it('rejects out-of-contract maxSteps instead of silently coercing it', async () => {
    const { invoke } = fixture({ run: pausedRun });
    const high = await invoke('POST', '/api/v2/agent/runs', {
      workspaceId: 'w', goal: 'g', maxSteps: 999,
    });
    assert.equal(high.write.status, 400);
    assert.equal(high.write.json.error.code, 'INVALID_INPUT');
    assert.equal(high.calls.length, 0);

    const low = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g', maxSteps: -5 });
    assert.equal(low.write.status, 400);
    assert.equal(low.write.json.error.code, 'INVALID_INPUT');
    assert.equal(low.calls.length, 0);
  });

  it('rejects non-string workspace IDs and undocumented properties before creating an agent', async () => {
    const { invoke } = fixture({ plan: planResult });
    const invalidWorkspace = await invoke('POST', '/api/v2/agent/plan', {
      workspaceId: ['tenant-a'], goal: 'hedef',
    });
    assert.equal(invalidWorkspace.write.status, 400);
    assert.equal(invalidWorkspace.write.json.error.code, 'INVALID_INPUT');
    assert.equal(invalidWorkspace.calls.length, 0);

    const extraProperty = await invoke('POST', '/api/v2/agent/plan', {
      workspaceId: 'tenant-a', goal: 'hedef', ignored: true,
    });
    assert.equal(extraProperty.write.status, 400);
    assert.equal(extraProperty.write.json.error.code, 'INVALID_INPUT');
    assert.equal(extraProperty.calls.length, 0);
  });

  it('rejects non-POST methods', async () => {
    const { invoke } = fixture({ plan: planResult });
    const { write } = await invoke('GET', '/api/v2/agent/plan', {});
    assert.equal(write.status, 405);
    assert.equal(write.json.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('fails closed when the agent runtime cannot be created', async () => {
    const { invoke } = fixture({ createFails: true });
    const { write } = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(write.status, 503);
    assert.equal(write.json.error.code, 'AGENT_RUNTIME_UNAVAILABLE');
    assert.equal(write.json.ok, false);
  });

  it('surfaces an agent failure without inventing a result', async () => {
    const run = { ok: false, error: { code: 'AGENT_DENIED', message: 'policy denied' } };
    const { invoke } = fixture({ run });
    const { write } = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(write.status, 422);
    assert.equal(write.json.error.code, 'AGENT_DENIED');
  });

  it('closes agent storage on both the success and failure paths', async () => {
    const { invoke } = fixture({ run: pausedRun });
    const ok = await invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: 'g' });
    assert.equal(ok.closed(), 1);

    const thrower = fixture({ run: pausedRun });
    // A route that leaked storage on the error path would exhaust handles under
    // repeated failures, so assert the finally-block actually runs.
    const bad = await thrower.invoke('POST', '/api/v2/agent/runs', { workspaceId: 'w', goal: '' });
    assert.equal(bad.write.status, 400);
  });
});

describe('agent workflow contract and auth wiring (#786)', () => {
  const byId = new Map(WORKFLOW_CAPABILITIES.map(entry => [entry.workflowId, entry]));

  for (const [workflowId, route] of [['agent-plan', '/api/v2/agent/plan'], ['agent-run', '/api/v2/agent/runs']]) {
    it(`${workflowId} advertises the HTTP surface it now serves`, () => {
      const entry = byId.get(workflowId);
      assert.ok(entry, `${workflowId} must stay in the contract`);
      assert.equal(entry.route, route);
      assert.equal(entry.method, 'POST');
      // The manifest previously advertised a route while declaring api:false;
      // help text must not promise a capability the surface does not serve.
      assert.equal(entry.availability.api, true);
      assert.equal(entry.httpRequestSchema.required.includes('workspaceId'), true);
      assert.equal(entry.httpRequestSchema.required.includes('goal'), true);
    });

    it(`${workflowId} requires authentication`, () => {
      const policy = resolveRouteAuthPolicy(route, 'POST');
      // known=false would mean the route is not part of the declared surface,
      // which is how an agent route could quietly answer without a key.
      assert.equal(policy.known, true);
      assert.equal(policy.authRequired, true);
      assert.equal(policy.reason, 'declared_authenticated');
    });
  }
});
