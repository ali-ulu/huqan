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
  // REFACTOR-4D: migrate private `kernel.graph?._nodes` access to the public
  // `graph.getNodes(workspaceId)` API. `extractFacts` accepts either an object
  // (uses Object.keys) or an array; both `_nodes` and `getNodes('default')`
  // return `{id: node}` for the default workspace, so the observable behavior
  // (which node IDs are considered "known" during fact extraction) is
  // preserved. Using the public API keeps discovery-engine off private graph
  // state. See docs/refactor/refactor-4d-contract-acceptance.md AC-5.5.
  const knownNodes = kernel.graph && typeof kernel.graph.getNodes === 'function'
    ? kernel.graph.getNodes('default')
    : (kernel.graph?._nodes || {});
  return kernel.extractFacts(text, knownNodes) || [];
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
