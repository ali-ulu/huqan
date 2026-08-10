const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAgent, resolveAgentRuntime } = require('./agentRuntime');

function createKernel() {
  return {
    verify(statement) {
      return {
        ok: true,
        data: {
          status: 'dogrulandi',
          confidence: 0.9,
          answer: `verified:${statement}`,
        },
        evidence: [{ kind: 'direct_edge', text: `verify:${statement}`, confidence: 0.9 }],
        meta: { source: 'kernel.verify' },
      };
    },
    detectContradictions(subject) {
      return [{ type: 'negation', description: `contradiction:${subject || 'all'}`, confidence: 0.7 }];
    },
    graph: {
      getStats() {
        return { nodes: 3, edges: 5, backend: 'sqlite' };
      },
    },
    async runCapability(name, input, opts) {
      return {
        ok: true,
        data: { capability: name, input, opts },
        evidence: ['capability-evidence'],
        confidence: 0.81,
      };
    },
  };
}

describe('agentRuntime', () => {
  it('keeps classic runtime as default', () => {
    const runtime = resolveAgentRuntime({});
    assert.notStrictEqual(runtime, 'workflow');

    const agent = createAgent({ kernel: createKernel() });
    assert.notStrictEqual(agent.kind, 'workflow');
  });

  it('selects workflow runtime when requested', async () => {
    const agent = createAgent({
      kernel: createKernel(),
      runtime: 'workflow',
      runCapabilityPolicy: ({ name }) => name === 'demo',
    });

    assert.strictEqual(agent.kind, 'workflow');
    assert.ok(Array.isArray(agent.listTools()));
    assert.ok(agent.listTools().some(tool => tool.name === 'verifyclaim'));

    const plan = agent.plan('verify graph and rank evidence');
    assert.strictEqual(plan.ok, true);
    assert.ok(plan.steps.length >= 1);

    const run = await agent.run('verify graph and rank evidence', {
      plan: {
        goal: 'verify graph and rank evidence',
        objective: 'verify',
        status: 'planned',
        maxSteps: 3,
        budget: 5,
        selectedTools: ['verifyclaim', 'getgraphstats', 'rankevidence'],
        steps: [
          {
            id: 'step-1',
            tool: 'verifyclaim',
            input: { statement: 'kedi hayvandir' },
            cost: 1,
          },
          {
            id: 'step-2',
            tool: 'getgraphstats',
            input: {},
            cost: 1,
          },
          {
            id: 'step-3',
            tool: 'rankevidence',
            input: {
              baseConfidence: 0.8,
              evidence: [{ type: 'docs', confidence: 0.7, text: 'docs evidence' }],
            },
            cost: 1,
          },
        ],
      },
    });

    assert.strictEqual(run.ok, true);
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.steps[0].tool, 'verifyclaim');
    assert.strictEqual(run.steps[1].tool, 'getgraphstats');
    assert.strictEqual(run.steps[2].tool, 'rankevidence');
    assert.ok(run.report.includes('Goal: verify graph and rank evidence'));

    const capability = await agent.runTool('runCapability', {
      name: 'demo',
      input: { foo: 'bar' },
      opts: { fast: true },
    });

    assert.strictEqual(capability.ok, true);
    assert.strictEqual(capability.data.capability, 'demo');
    assert.deepStrictEqual(capability.data.input, { foo: 'bar' });
    assert.deepStrictEqual(capability.data.opts, { fast: true });
  });
});
