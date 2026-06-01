const { describe, it } = require('node:test');
const assert = require('node:assert');
const WorkflowAgent = require('./workflow-agent');
const { ToolRegistry } = require('./workflow-agent');

function createAgent(opts = {}) {
  const agent = new WorkflowAgent({ maxSteps: 4, ...opts });

  agent.registerTool({
    name: 'ask',
    description: 'collect context',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          answer: `ask:${input.goal}`,
          source: 'ask',
        },
        evidence: [{ type: 'graph', value: 'ask-evidence' }],
        confidence: 0.61,
      };
    },
  });

  agent.registerTool({
    name: 'verify',
    description: 'verify a claim',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          finalAnswer: `verify:${input.goal}`,
          status: 'dogrulandi',
          source: 'verify',
        },
        evidence: ['verify-evidence'],
        confidence: 0.87,
      };
    },
  });

  agent.registerTool({
    name: 'reason',
    description: 'build a causal chain',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          analysis: `reason:${input.goal}`,
          source: 'reason',
        },
        evidence: [{
          type: 'reason',
          value: 'reason-evidence',
          confidence: '0.4',
        }],
        confidence: '0.73',
      };
    },
  });

  return agent;
}

function registerDiscoveryTools(agent) {
  agent.registerTool({
    name: 'discoveryEngine',
    description: 'discover hypotheses',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          hypothesis: `discovery:${input.goal}`,
          nextAction: 'experimentPlanner',
          source: 'discoveryEngine',
        },
        evidence: [{ type: 'graph', value: 'discovery-evidence' }],
        confidence: 0.62,
      };
    },
  });

  agent.registerTool({
    name: 'experimentPlanner',
    description: 'plan experiments',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          plan: [{ step: 'collect evidence', tool: 'resultAnalyzer' }],
          nextAction: 'resultAnalyzer',
          source: 'experimentPlanner',
        },
        evidence: [{ type: 'graph', value: 'experiment-plan' }],
        confidence: 0.69,
      };
    },
  });

  agent.registerTool({
    name: 'resultAnalyzer',
    description: 'analyze results',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          analysis: `analyzed:${input.goal}`,
          nextAction: 'replicationChecker',
          source: 'resultAnalyzer',
        },
        evidence: [{ type: 'graph', value: 'analysis-evidence' }],
        confidence: 0.78,
      };
    },
  });

  agent.registerTool({
    name: 'replicationChecker',
    description: 'check replication',
    inputSchema: { type: 'object' },
    run(context, input) {
      return {
        ok: true,
        data: {
          finalAnswer: `replication:${input.goal}`,
          status: 'verified',
          source: 'replicationChecker',
        },
        evidence: [{ type: 'graph', value: 'replication-evidence' }],
        confidence: 0.91,
      };
    },
  });

  return agent;
}

describe('workflow-agent', () => {
  it('registerTool() stores metadata and listTools() returns registered tools', () => {
    const registry = new ToolRegistry();
    const registered = registry.registerTool({
      name: 'alpha',
      description: 'first tool',
      inputSchema: { type: 'object' },
      run() {
        return { ok: true, data: { answer: 'ok' } };
      },
    });

    assert.strictEqual(registered.name, 'alpha');
    assert.strictEqual(registered.description, 'first tool');
    assert.ok(!Object.prototype.hasOwnProperty.call(registered, 'run'));

    const tools = registry.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'alpha');
    assert.strictEqual(tools[0].description, 'first tool');
    assert.deepStrictEqual(tools[0].inputSchema, { type: 'object' });
  });

  it('plan(goal) returns a deterministic step sequence', () => {
    const agent = createAgent();
    const plan1 = agent.plan('kedi hayvandir mi?');
    const plan2 = agent.plan('kedi hayvandir mi?');

    assert.strictEqual(plan1.ok, true);
    assert.strictEqual(plan1.status, 'planned');
    assert.deepStrictEqual(plan1.steps.map(step => step.tool), ['ask', 'verify', 'reason']);
    assert.deepStrictEqual(plan1.steps.map(step => step.tool), plan2.steps.map(step => step.tool));
    assert.ok(plan1.trace.length >= 3);
    assert.ok(plan1.trace.some(item => item.phase === 'plan' && item.tool === 'ask'));
    assert.ok(plan1.nextAction);
    assert.strictEqual(plan1.nextAction.action, 'run');
  });

  it('run(goal) calls tools, collects evidence, and returns a report', () => {
    const agent = createAgent();
    const result = agent.run('kedi hayvandir mi?');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.steps.length, 3);
    assert.ok(result.steps.every(step => Array.isArray(step.evidence)));
    assert.ok(result.steps.every(step => typeof step.confidence === 'number'));
    assert.ok(result.evidence.length >= 3);
    assert.ok(result.trace.some(item => item.phase === 'plan'));
    assert.ok(result.trace.some(item => item.phase === 'run'));
    assert.ok(result.report.includes('Goal: kedi hayvandir mi?'));
    assert.ok(result.report.includes('Next action: none'));
    assert.ok(result.report.includes('Final summary:'));
    assert.ok(result.report.includes('Final answer: verify:kedi hayvandir mi?'));
    assert.strictEqual(result.nextAction.action, 'none');
    assert.ok(Array.isArray(result.recommendations));
    assert.ok(result.recommendations.includes('No immediate action required.'));
    assert.strictEqual(result.finalAnswer, 'verify:kedi hayvandir mi?');
    assert.ok(result.finalSummary);
    assert.strictEqual(typeof result.finalSummary.mode, 'string');
  });

  it('rejects unknown tools', () => {
    const agent = new WorkflowAgent();
    const result = agent.run('unknown tool', {
      plan: {
        goal: 'unknown tool',
        objective: 'inspect',
        status: 'planned',
        maxSteps: 1,
        budget: 1,
        selectedTools: ['missing'],
        steps: [{
          id: 'step-1',
          tool: 'missing',
          input: { goal: 'unknown tool' },
          cost: 1,
        }],
        evidence: [],
        confidence: 0.4,
        trace: [],
        errors: [],
        recommendations: [],
        finalAnswer: '',
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.steps[0].status, 'blocked');
    assert.strictEqual(result.errors[0].code, 'UNKNOWN_TOOL');
    assert.strictEqual(result.nextAction.action, 'revise');
  });

  it('stops at maxSteps and reports a pause', () => {
    const agent = createAgent({ maxSteps: 4 });
    const plan = agent.plan('kedi hayvandir mi?', { maxSteps: 4 });
    const result = agent.run('kedi hayvandir mi?', {
      plan,
      maxSteps: 1,
      budget: 10,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'paused');
    assert.strictEqual(result.steps.length, 1);
    assert.strictEqual(result.nextAction.action, 'resume');
    assert.ok(result.report.includes('Status: paused'));
  });

  it('returns partial or failed when a tool throws', () => {
    const agent = new WorkflowAgent({ maxSteps: 2 });
    agent.registerTool({
      name: 'boom',
      description: 'throws on purpose',
      inputSchema: { type: 'object' },
      run() {
        throw new Error('boom');
      },
    });

    const result = agent.run('boom now', {
      plan: {
        goal: 'boom now',
        objective: 'inspect',
        status: 'planned',
        maxSteps: 1,
        budget: 1,
        selectedTools: ['boom'],
        steps: [{
          id: 'step-1',
          tool: 'boom',
          input: { goal: 'boom now' },
          cost: 1,
        }],
        evidence: [],
        confidence: 0.2,
        trace: [],
        errors: [],
        recommendations: [],
        finalAnswer: '',
      },
    });

    assert.strictEqual(result.ok, false);
    assert.ok(['partial', 'failed'].includes(result.status));
    assert.strictEqual(result.steps[0].status, 'error');
    assert.strictEqual(result.errors[0].code, 'TOOL_ERROR');
  });

  it('normalizes evidence and confidence', () => {
    const agent = new WorkflowAgent({ maxSteps: 1 });
    agent.registerTool({
      name: 'ask',
      description: 'context collector',
      inputSchema: { type: 'object' },
      run(context, input) {
        return {
          ok: true,
          data: {
            answer: 'normalized answer',
            confidence: '2',
          },
          evidence: { id: 'e1', confidence: '0.9' },
          confidence: '2',
        };
      },
    });

    const result = agent.run('normalize this');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.confidence, 1);
    assert.ok(Array.isArray(result.evidence));
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.steps[0].confidence, 1);
    assert.strictEqual(result.steps[0].evidence.length, 1);
    assert.strictEqual(result.finalAnswer, 'normalized answer');
  });

  it('keeps trace entries for every executed step', () => {
    const agent = createAgent();
    const result = agent.run('kedi hayvandir mi?');

    assert.ok(Array.isArray(result.trace));
    assert.ok(result.trace.some(item => item.phase === 'plan'));
    assert.ok(result.trace.some(item => item.phase === 'run'));
    assert.strictEqual(result.steps.length, 3);
    assert.strictEqual(result.steps.every(step => Array.isArray(step.trace) && step.trace.length === 1), true);
    assert.ok(result.trace.filter(item => item.phase === 'run').length >= result.steps.length);
  });

  it('plans and runs discovery goals with the discovery tool sequence', () => {
    const agent = registerDiscoveryTools(createAgent());
    const plan = agent.plan('discover a useful hypothesis and experiment plan');
    const result = agent.run('discover a useful hypothesis and experiment plan');

    assert.strictEqual(plan.objective, 'discover');
    assert.deepStrictEqual(plan.steps.map(step => step.tool), [
      'discoveryengine',
      'experimentplanner',
      'resultanalyzer',
      'replicationchecker',
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(result.steps.map(step => step.tool), [
      'discoveryengine',
      'experimentplanner',
      'resultanalyzer',
      'replicationchecker',
    ]);
    assert.ok(result.report.includes('Objective: discover'));
    assert.ok(result.report.includes('Final summary:'));
    assert.ok(result.finalAnswer.includes('replication:'));
    assert.strictEqual(result.nextAction.action, 'none');
  });
});
