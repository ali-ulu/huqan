const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  if (input && typeof input.goal === 'string') return input.goal.trim();
  if (input && typeof input.hypothesis === 'string') return input.hypothesis.trim();
  return '';
}

function toFacts(kernel, text) {
  if (!kernel || typeof kernel.extractFacts !== 'function') return [];
  return kernel.extractFacts(text, kernel.graph?._nodes || {}) || [];
}

function toEvidence(facts, source) {
  return facts.map(fact => ({
    kind: 'fact',
    text: `${fact.subject} ${fact.predicate}`.trim(),
    confidence: 0.6,
    source,
  }));
}

function createDiscoveryEnginePlugin() {
  return {
    name: 'discovery-engine',
    version: '0.1.0',
    capabilities: [
      {
        name: 'discoveryEngine',
        command: 'discover',
        description: 'Creates a skeleton discovery hypothesis set from a goal or hypothesis.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      if (!text) {
        return {
          ok: false,
          plugin: 'discovery-engine',
          capability: opts.capability?.name || 'discoveryEngine',
          error: { code: 'INVALID_INPUT', message: 'goal or text is required' },
          data: {
            status: 'insufficient_input',
            source: 'discovery-engine',
            capability: 'discoveryEngine',
            output: {
              goal: '',
              hypotheses: [],
              nextAction: 'experimentPlanner',
            },
            evidence: [],
            confidence: 0,
          },
          evidence: [],
          confidence: 0,
        };
      }

      const facts = toFacts(kernel, text);
      const source = facts.length > 0 ? 'graph' : 'parsed';
      const hypotheses = facts.length > 0
        ? facts.map(fact => ({
            subject: fact.subject,
            predicate: fact.predicate,
            source,
          }))
        : [{
            subject: text,
            predicate: 'requires experiment planning',
            source,
          }];
      const evidence = facts.length > 0
        ? toEvidence(facts, source)
        : [{
            kind: 'parsed_goal',
            text,
            confidence: 0.45,
            source,
          }];
      const baseConfidence = facts.length > 0 ? 0.58 : 0.52;
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(baseConfidence, facts.length > 0 ? 'docs' : 'chat_memory')
        : baseConfidence;

      return {
        ok: true,
        plugin: 'discovery-engine',
        capability: opts.capability?.name || 'discoveryEngine',
        data: {
          status: 'ready',
          source: 'discovery-engine',
          capability: 'discoveryEngine',
          output: {
            goal: text,
            hypotheses,
            nextAction: 'experimentPlanner',
            source,
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

module.exports = createDiscoveryEnginePlugin();
module.exports.create = createDiscoveryEnginePlugin;
