const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createWorkflowRuntime } = require('./workflow-runtime');

function createKernel() {
  return {
    verify(statement) {
      return {
        ok: true,
        data: {
          status: 'dogrulandi',
          confidence: 0.91,
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
        return { nodes: 7, edges: 11, backend: 'sqlite' };
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

describe('workflow-runtime', () => {
  it('creates a runtime with default workflow tools registered', () => {
    const runtime = createWorkflowRuntime(createKernel());

    const toolNames = runtime.listTools().map(tool => tool.name);
    assert.ok(toolNames.includes('verifyclaim'));
    assert.ok(toolNames.includes('findcontradictions'));
    assert.ok(toolNames.includes('rankevidence'));
    assert.ok(toolNames.includes('runcapability'));
    assert.ok(toolNames.includes('getgraphstats'));
    assert.strictEqual(runtime.getStatus().agent, 'workflow');
  });

  it('plans and runs adapter tools through WorkflowAgent', async () => {
    const runtime = createWorkflowRuntime(createKernel(), { maxSteps: 4 });
    const plan = runtime.plan('verify graph and rank evidence');

    assert.strictEqual(plan.ok, true);
    assert.ok(plan.steps.length >= 1);

    const run = runtime.run('verify graph and rank evidence', {
      plan: {
        goal: 'verify graph and rank evidence',
        objective: 'verify',
        status: 'planned',
        maxSteps: 4,
        budget: 10,
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
    assert.strictEqual(run.steps.length, 3);
    assert.strictEqual(run.steps[0].tool, 'verifyclaim');
    assert.strictEqual(run.steps[1].tool, 'getgraphstats');
    assert.strictEqual(run.steps[2].tool, 'rankevidence');
    assert.strictEqual(run.steps[0].output.claim, 'kedi hayvandir');
    assert.deepStrictEqual(run.steps[1].output.stats, { nodes: 7, edges: 11, backend: 'sqlite' });
    assert.ok(run.steps[2].output.adjustedConfidence <= 1);
    assert.ok(run.report.includes('Goal: verify graph and rank evidence'));
    assert.ok(run.report.includes('Final answer:'));
    assert.ok(runtime.getStatus().lastRun);
  });

  it('runs runCapability through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('runCapability', {
      name: 'demo',
      input: { foo: 'bar' },
      opts: { fast: true },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'demo');
    assert.strictEqual(result.data.input.foo, 'bar');
    assert.deepStrictEqual(result.data.input, { foo: 'bar' });
    assert.deepStrictEqual(result.data.opts, { fast: true });
  });

  it('exposes listTools and getStatus after a run', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.run('verify kedi hayvandir mi?', {
      plan: {
        goal: 'verify kedi hayvandir mi?',
        objective: 'verify',
        status: 'planned',
        maxSteps: 1,
        budget: 5,
        selectedTools: ['verifyclaim'],
        steps: [
          {
            id: 'step-1',
            tool: 'verifyclaim',
            input: { statement: 'kedi hayvandir' },
            cost: 1,
          },
        ],
      },
    });

    assert.strictEqual(result.ok, true);
    const status = runtime.getStatus();
    assert.strictEqual(status.agent, 'workflow');
    assert.strictEqual(typeof status.tools, 'number');
    assert.ok(status.lastRun);
    assert.strictEqual(status.lastRun.goal, 'verify kedi hayvandir mi?');
    assert.strictEqual(status.lastRun.status, 'completed');
  });
});
