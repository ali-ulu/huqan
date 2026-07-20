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
      if (name === 'discoveryEngine') {
        return {
          ok: true,
          data: {
            capability: name,
            status: 'ready',
            source: 'discovery-engine',
            output: {
              goal: input.goal || input.text || '',
              hypotheses: [{
                subject: input.goal || input.text || 'goal',
                predicate: 'requires experiment planning',
                source: 'parsed',
              }],
              nextAction: 'experimentPlanner',
            },
          },
          evidence: ['discovery-evidence'],
          confidence: 0.64,
        };
      }
      if (name === 'experimentPlanner') {
        return {
          ok: true,
          data: {
            capability: name,
            status: 'ready',
            source: 'experiment-planner',
            output: {
              hypothesis: input.hypothesis || input.goal || '',
              plan: [{ step: 'collect evidence', tool: 'resultAnalyzer' }],
              successCriteria: ['clear hypothesis'],
              nextAction: 'resultAnalyzer',
            },
          },
          evidence: ['plan-evidence'],
          confidence: 0.57,
        };
      }
      if (name === 'resultAnalyzer') {
        return {
          ok: true,
          data: {
            capability: name,
            status: 'ready',
            source: 'result-analyzer',
            output: {
              signal: 'support',
              summary: input.result || input.observation || input.text || '',
              updatedHypothesis: 'strengthen',
              nextAction: 'replicationChecker',
            },
          },
          evidence: ['analysis-evidence'],
          confidence: 0.58,
        };
      }
      if (name === 'replicationChecker') {
        return {
          ok: true,
          data: {
            capability: name,
            status: 'ready',
            source: 'replication-checker',
            output: {
              replicationStatus: 'replicable',
              repeatCount: Array.isArray(input.runs) ? input.runs.length : 2,
              consistency: 'stable',
              nextAction: 'discoveryEngine',
            },
          },
          evidence: ['replication-evidence'],
          confidence: 0.61,
        };
      }
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
      'repoMemory',
      'companyBrain',
      'discoveryEngine',
      'experimentPlanner',
      'resultAnalyzer',
      'replicationChecker',
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

  it('runCapability prefers the governed Kernel facade over PluginManager', async () => {
    const calls = [];
    const kernel = createKernel({
      async runCapability() {
        calls.push('kernel');
        return { ok: true, data: { owner: 'kernel' } };
      },
      plugins: {
        async runCapability() {
          calls.push('plugins');
          return { ok: true, data: { owner: 'plugins' } };
        },
      },
    });
    const tool = createWorkflowTools(kernel).find(item => item.name === 'runCapability');

    const result = await tool.run({}, { name: 'demo' });

    assert.deepStrictEqual(calls, ['kernel']);
    assert.strictEqual(result.data.owner, 'kernel');
    assert.strictEqual(result.meta.source, 'kernel.runCapability');
  });

  it('runCapability labels the bounded PluginManager compatibility fallback', async () => {
    const kernel = createKernel({
      runCapability: undefined,
      plugins: {
        async runCapability() {
          return { ok: true, data: { owner: 'plugins' } };
        },
      },
    });
    const tool = createWorkflowTools(kernel).find(item => item.name === 'runCapability');

    const result = await tool.run({}, { name: 'demo' });

    assert.strictEqual(result.data.owner, 'plugins');
    assert.strictEqual(result.meta.source, 'plugin-manager');
  });

  it('repoMemory calls kernel.runCapability and forwards repo ingest input', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'repoMemory');
    const result = await tool.run({}, {
      sourceType: 'markdown',
      path: 'docs/README.md',
      action: 'ingest',
      sessionId: 'session-1',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'repoMemory');
    assert.strictEqual(result.data.value.sourceType, 'markdown');
    assert.strictEqual(result.data.value.path, 'docs/README.md');
    assert.strictEqual(result.data.value.action, 'ingest');
    assert.strictEqual(result.data.value.sessionId, 'session-1');
  });

  it('companyBrain calls kernel.runCapability and forwards company query input', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'companyBrain');
    const result = await tool.run({}, {
      action: 'query',
      question: 'Bu repo neden var?',
      sessionId: 'session-2',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'companyBrain');
    assert.strictEqual(result.data.source, 'company-brain');
    assert.strictEqual(result.data.input.question, 'Bu repo neden var?');
    assert.strictEqual(result.data.input.action, 'query');
    assert.strictEqual(result.data.input.sessionId, 'session-2');
  });

  it('discoveryEngine calls kernel.runCapability and returns hypotheses', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'discoveryEngine');
    const result = await tool.run({}, {
      goal: 'Find a useful hypothesis',
      text: 'Find a useful hypothesis',
      sessionId: 'session-3',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'discoveryEngine');
    assert.strictEqual(result.data.source, 'discovery-engine');
    assert.ok(Array.isArray(result.data.output.hypotheses));
    assert.strictEqual(result.data.output.nextAction, 'experimentPlanner');
  });

  it('experimentPlanner calls kernel.runCapability and returns a plan', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'experimentPlanner');
    const result = await tool.run({}, {
      goal: 'Validate a hypothesis',
      hypothesis: 'Validate a hypothesis',
      sessionId: 'session-4',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'experimentPlanner');
    assert.strictEqual(result.data.source, 'experiment-planner');
    assert.ok(Array.isArray(result.data.output.plan));
    assert.strictEqual(result.data.output.nextAction, 'resultAnalyzer');
  });

  it('resultAnalyzer calls kernel.runCapability and returns analysis', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'resultAnalyzer');
    const result = await tool.run({}, {
      result: 'support',
      sessionId: 'session-5',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'resultAnalyzer');
    assert.strictEqual(result.data.source, 'result-analyzer');
    assert.strictEqual(result.data.output.signal, 'support');
    assert.strictEqual(result.data.output.nextAction, 'replicationChecker');
  });

  it('replicationChecker calls kernel.runCapability and returns replication status', async () => {
    const tool = createWorkflowTools(createKernel()).find(item => item.name === 'replicationChecker');
    const result = await tool.run({}, {
      runs: [{ id: 1 }, { id: 2 }],
      sessionId: 'session-6',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'replicationChecker');
    assert.strictEqual(result.data.source, 'replication-checker');
    assert.strictEqual(result.data.output.replicationStatus, 'replicable');
    assert.strictEqual(result.data.output.nextAction, 'discoveryEngine');
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
    const repoMemory = tools.find(item => item.name === 'repoMemory');
    const companyBrain = tools.find(item => item.name === 'companyBrain');
    const discoveryEngine = tools.find(item => item.name === 'discoveryEngine');
    const experimentPlanner = tools.find(item => item.name === 'experimentPlanner');
    const resultAnalyzer = tools.find(item => item.name === 'resultAnalyzer');
    const replicationChecker = tools.find(item => item.name === 'replicationChecker');

    assert.strictEqual(verify.run({}, { statement: 'kedi' }).ok, false);
    assert.strictEqual(contradiction.run({}, { subject: 'kedi' }).ok, false);
    assert.strictEqual(graphStats.run().ok, false);
    const runResult = await runCapability.run({}, { name: 'missing' });
    assert.strictEqual(runResult.ok, false);
    assert.strictEqual(runResult.status, 'error');
    const repoResult = await repoMemory.run({}, { sourceType: 'github', repoUrl: 'https://example.com/org/repo' });
    assert.strictEqual(repoResult.ok, false);
    assert.strictEqual(repoResult.status, 'error');
    const companyResult = await companyBrain.run({}, { question: 'Bu repo neden var?' });
    assert.strictEqual(companyResult.ok, false);
    assert.strictEqual(companyResult.status, 'unavailable');
    const discoveryResult = await discoveryEngine.run({}, { goal: 'find hypotheses' });
    assert.strictEqual(discoveryResult.ok, false);
    assert.strictEqual(discoveryResult.status, 'unavailable');
    const experimentResult = await experimentPlanner.run({}, { goal: 'plan experiment' });
    assert.strictEqual(experimentResult.ok, false);
    assert.strictEqual(experimentResult.status, 'unavailable');
    const analysisResult = await resultAnalyzer.run({}, { result: 'support' });
    assert.strictEqual(analysisResult.ok, false);
    assert.strictEqual(analysisResult.status, 'unavailable');
    const replicationResult = await replicationChecker.run({}, { runs: [{ id: 1 }] });
    assert.strictEqual(replicationResult.ok, false);
    assert.strictEqual(replicationResult.status, 'unavailable');
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
