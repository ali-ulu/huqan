const { describe, it } = require('node:test');
const assert = require('node:assert');
const WorkflowAgent = require('./workflow-agent');
const { createWorkflowTools, registerDefaultWorkflowTools } = require('./workflow-tools');

function createKernel(overrides = {}) {
  return {
    verify(statement, opts) {
      return {
        ok: true,
        data: {
          status: 'dogrulandi',
          confidence: 0.88,
          answer: `verified:${statement}`,
        },
        evidence: [{ kind: 'direct_edge', text: `evidence:${statement}`, confidence: 0.9 }],
        meta: { source: 'kernel.verify', opts },
      };
    },
    detectContradictions(subject) {
      return [
        {
          type: 'negation',
          description: `Contradiction for ${subject || 'global'}`,
          confidence: 0.66,
        },
      ];
    },
    graph: {
      getStats() {
        return { nodes: 12, edges: 34, backend: 'sqlite' };
      },
    },
    async runCapability(name, input, opts) {
      return {
        ok: true,
        data: {
          capability: name,
          value: input,
          opts,
        },
        evidence: ['capability-evidence'],
        confidence: 0.73,
      };
    },
    ...overrides,
  };
}

function createMissingKernel() {
  return {
    graph: {},
  };
}

describe('workflow-tools', () => {
  it('createWorkflowTools(kernel) returns the expected adapter tools', () => {
    const tools = createWorkflowTools(createKernel());
    const names = tools.map(tool => tool.name);

    assert.deepStrictEqual(names, [
      'verifyClaim',
      'findContradictions',
      'rankEvidence',
      'runCapability',
      'getGraphStats',
    ]);
    assert.ok(tools.every(tool => typeof tool.run === 'function'));
  });

  it('verifyClaim wraps kernel.verify and normalizes the output', () => {
    const tool = createWorkflowTools(createKernel())[0];
    const result = tool.run({}, { statement: 'kedi hayvandir' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.status, 'dogrulandi');
    assert.strictEqual(result.data.claim, 'kedi hayvandir');
    assert.strictEqual(result.confidence, 0.88);
    assert.ok(Array.isArray(result.evidence));
    assert.ok(result.evidence.length >= 1);
  });

  it('findContradictions wraps kernel.detectContradictions', () => {
    const tools = createWorkflowTools(createKernel());
    const tool = tools.find(item => item.name === 'findContradictions');
    const result = tool.run({}, { subject: 'kedi' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.count, 1);
    assert.ok(Array.isArray(result.data.contradictions));
    assert.ok(result.evidence.some(item => item.kind === 'negation'));
  });

  it('rankEvidence uses evidence-ranker weights and adjusted confidence', () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'rankEvidence');
    const result = tool.run({}, {
      baseConfidence: 0.8,
      evidence: [
        { type: 'blog', confidence: 0.8, text: 'blog item' },
        { type: 'peer_reviewed', confidence: 0.5, text: 'paper' },
      ],
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.ok(result.data.adjustedConfidence <= 1);
    assert.ok(result.data.adjustedConfidence >= 0);
    assert.ok(result.data.evidence[0].adjustedConfidence >= result.data.evidence[1].adjustedConfidence);
    assert.ok(result.data.weights.peer_reviewed > result.data.weights.blog);
  });

  it('runCapability calls kernel.runCapability and awaits async execution', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'runCapability');
    const result = await tool.run({}, {
      name: 'demo',
      input: { hello: 'world' },
      opts: { approve: true },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'demo');
    assert.deepStrictEqual(result.data.value, { hello: 'world' });
    assert.deepStrictEqual(result.data.opts, { approve: true });
    assert.ok(result.evidence.length >= 1);
  });

  it('getGraphStats exposes graph statistics', () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'getGraphStats');
    const result = tool.run();

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.deepStrictEqual(result.data.stats, { nodes: 12, edges: 34, backend: 'sqlite' });
  });

  it('missing kernel methods fail gracefully', async () => {
    const tools = createWorkflowTools(createMissingKernel());

    const verify = tools.find(item => item.name === 'verifyClaim');
    const contradiction = tools.find(item => item.name === 'findContradictions');
    const graphStats = tools.find(item => item.name === 'getGraphStats');
    const runCapability = tools.find(item => item.name === 'runCapability');

    assert.strictEqual(verify.run({}, { statement: 'kedi' }).ok, false);
    assert.strictEqual(contradiction.run({}, { subject: 'kedi' }).ok, false);
    assert.strictEqual(graphStats.run().ok, false);
    const runResult = await runCapability.run({}, { name: 'missing' });
    assert.strictEqual(runResult.ok, false);
    assert.strictEqual(runResult.status, 'error');
  });

  it('registerDefaultWorkflowTools registers tools into a registry', async () => {
    const agent = new WorkflowAgent({ maxSteps: 1 });
    const tools = registerDefaultWorkflowTools(agent.registry, createKernel());

    assert.ok(Array.isArray(tools));
    assert.strictEqual(agent.listTools().length >= 5, true);
    assert.ok(agent.getTool('verifyClaim'));
    assert.ok(agent.getTool('rankEvidence'));

    const runCapability = tools.find(tool => tool.name === 'runCapability');
    const registeredRun = await runCapability.run({}, { name: 'demo', input: { a: 1 } });
    assert.strictEqual(registeredRun.ok, true);
    assert.strictEqual(registeredRun.status, 'done');
  });
});
