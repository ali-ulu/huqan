const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('./kernel');
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
    assert.ok(toolNames.includes('repomemory'));
    assert.ok(toolNames.includes('companybrain'));
    assert.ok(toolNames.includes('discoveryengine'));
    assert.ok(toolNames.includes('experimentplanner'));
    assert.ok(toolNames.includes('resultanalyzer'));
    assert.ok(toolNames.includes('replicationchecker'));
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

  it('runs repoMemory through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('repoMemory', {
      action: 'ingest',
      sourceType: 'markdown',
      path: 'docs/README.md',
      sessionId: 'session-1',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.data.capability, 'repoMemory');
    assert.strictEqual(result.data.sourceType, 'markdown');
    assert.strictEqual(result.data.action, 'ingest');
    assert.strictEqual(result.data.input.path, 'docs/README.md');
    assert.strictEqual(result.data.input.sessionId, 'session-1');
  });

  it('runs companyBrain through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('companyBrain', {
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

  it('runs discoveryEngine through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('discoveryEngine', {
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

  it('runs experimentPlanner through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('experimentPlanner', {
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

  it('runs resultAnalyzer through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('resultAnalyzer', {
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

  it('runs replicationChecker through the workflow tool adapter', async () => {
    const runtime = createWorkflowRuntime(createKernel());
    const result = await runtime.runTool('replicationChecker', {
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

  it('lists and runs the discovery skeleton through the real plugin manager', async () => {
    const kernel = new Kernel({ noLoad: true, loadPlugins: false });
    kernel.enableCapability('pluginCapabilities');
    kernel.usePlugin(require('./plugins/discovery-engine'));
    kernel.usePlugin(require('./plugins/experiment-planner'));
    kernel.usePlugin(require('./plugins/result-analyzer'));
    kernel.usePlugin(require('./plugins/replication-checker'));

    const runtime = createWorkflowRuntime(kernel, { registerDefaultTools: true });
    const toolNames = runtime.listTools().map(tool => tool.name);

    assert.ok(toolNames.includes('discoveryengine'));
    assert.ok(toolNames.includes('experimentplanner'));
    assert.ok(toolNames.includes('resultanalyzer'));
    assert.ok(toolNames.includes('replicationchecker'));

    const discovery = await runtime.runTool('discoveryEngine', {
      goal: 'Find a useful hypothesis',
      text: 'Find a useful hypothesis',
    });
    const experiment = await runtime.runTool('experimentPlanner', {
      hypothesis: 'Validate a hypothesis',
      text: 'Validate a hypothesis',
    });
    const analysis = await runtime.runTool('resultAnalyzer', {
      result: 'support',
      text: 'support',
    });
    const replication = await runtime.runTool('replicationChecker', {
      runs: [{ id: 1 }, { id: 2 }],
      text: 'support',
    });

    assert.strictEqual(discovery.ok, true);
    assert.strictEqual(experiment.ok, true);
    assert.strictEqual(analysis.ok, true);
    assert.strictEqual(replication.ok, true);
    assert.strictEqual(discovery.data.capability, 'discoveryEngine');
    assert.strictEqual(experiment.data.capability, 'experimentPlanner');
    assert.strictEqual(analysis.data.capability, 'resultAnalyzer');
    assert.strictEqual(replication.data.capability, 'replicationChecker');
  });
});
