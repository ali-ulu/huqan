const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.result === 'string') return input.result.trim();
  if (input && typeof input.observation === 'string') return input.observation.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  return '';
}

function classifySignal(text) {
  const normalized = String(text || '').toLowerCase();
  if (/(support|confirm|positive|pass|true|works|valid)/i.test(normalized)) return 'support';
  if (/(reject|fail|negative|false|deny|broken|invalid)/i.test(normalized)) return 'reject';
  return 'mixed';
}

function createResultAnalyzerPlugin() {
  return {
    name: 'result-analyzer',
    version: '0.1.0',
    capabilities: [
      {
        name: 'resultAnalyzer',
        command: 'analyze-result',
        description: 'Turns an experiment result into a minimal evidence summary.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      if (!text) {
        return {
          ok: false,
          plugin: 'result-analyzer',
          capability: opts.capability?.name || 'resultAnalyzer',
          error: { code: 'INVALID_INPUT', message: 'result or observation is required' },
          data: {
            status: 'insufficient_input',
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
            output: {
              signal: 'mixed',
              summary: '',
              nextAction: 'experimentPlanner',
            },
            evidence: [],
            confidence: 0,
          },
          evidence: [],
          confidence: 0,
        };
      }

      const signal = classifySignal(text);
      const evidence = [{
        kind: 'analysis',
        text: `Signal classified as ${signal}: ${text}`,
        confidence: 0.55,
        source: 'result-analyzer',
      }];
      const baseConfidence = signal === 'mixed' ? 0.48 : 0.6;
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(baseConfidence, 'docs')
        : baseConfidence;

      return {
        ok: true,
        plugin: 'result-analyzer',
        capability: opts.capability?.name || 'resultAnalyzer',
        data: {
          status: 'ready',
          source: 'result-analyzer',
          capability: 'resultAnalyzer',
          output: {
            signal,
            summary: text,
            updatedHypothesis: signal === 'support' ? 'strengthen' : signal === 'reject' ? 'revise' : 'refine',
            nextAction: signal === 'support' ? 'replicationChecker' : 'experimentPlanner',
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

module.exports = createResultAnalyzerPlugin();
module.exports.create = createResultAnalyzerPlugin;
