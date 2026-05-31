const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  if (input && typeof input.goal === 'string') return input.goal.trim();
  if (input && typeof input.hypothesis === 'string') return input.hypothesis.trim();
  return '';
}

function createExperimentPlannerPlugin() {
  return {
    name: 'experiment-planner',
    version: '0.1.0',
    capabilities: [
      {
        name: 'experimentPlanner',
        command: 'plan-experiment',
        description: 'Produces a minimal experiment plan for a discovery hypothesis.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      if (!text) {
        return {
          ok: false,
          plugin: 'experiment-planner',
          capability: opts.capability?.name || 'experimentPlanner',
          error: { code: 'INVALID_INPUT', message: 'hypothesis or goal is required' },
          data: {
            status: 'insufficient_input',
            source: 'experiment-planner',
            capability: 'experimentPlanner',
            output: {
              hypothesis: '',
              plan: [],
              successCriteria: [],
            },
            evidence: [],
            confidence: 0,
          },
          evidence: [],
          confidence: 0,
        };
      }

      const plan = [
        {
          step: 'frame hypothesis',
          tool: 'discoveryEngine',
          intent: 'clarify the claim before testing',
        },
        {
          step: 'collect supporting evidence',
          tool: 'verifyClaim',
          intent: 'check whether the current graph supports the hypothesis',
        },
        {
          step: 'analyze result',
          tool: 'resultAnalyzer',
          intent: 'summarize the signal and next action',
        },
      ];
      const successCriteria = [
        'the hypothesis is stated in one sentence',
        'evidence sources are identified',
        'the next action is explicit',
      ];
      const evidence = [{
        kind: 'plan',
        text: `Plan created for: ${text}`,
        confidence: 0.5,
        source: 'experiment-planner',
      }];
      const baseConfidence = 0.55;
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(baseConfidence, 'docs')
        : baseConfidence;

      return {
        ok: true,
        plugin: 'experiment-planner',
        capability: opts.capability?.name || 'experimentPlanner',
        data: {
          status: 'ready',
          source: 'experiment-planner',
          capability: 'experimentPlanner',
          output: {
            hypothesis: text,
            plan,
            successCriteria,
            nextAction: 'resultAnalyzer',
          },
          evidence,
          confidence,
        },
        evidence,
        confidence,
      };
    },
  };
}

module.exports = createExperimentPlannerPlugin();
module.exports.create = createExperimentPlannerPlugin;
