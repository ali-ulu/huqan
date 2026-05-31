const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  return '';
}

function countSignals(input) {
  if (Array.isArray(input?.runs)) return input.runs.length;
  if (Array.isArray(input?.observations)) return input.observations.length;
  if (Array.isArray(input?.sourceRefs)) return input.sourceRefs.length;
  return normalizeInput(input) ? 1 : 0;
}

function createReplicationCheckerPlugin() {
  return {
    name: 'replication-checker',
    version: '0.1.0',
    capabilities: [
      {
        name: 'replicationChecker',
        command: 'check-replication',
        description: 'Checks whether a discovery result is repeated enough to be reliable.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      const repeatCount = countSignals(input);
      if (!text && repeatCount === 0) {
        return {
          ok: false,
          plugin: 'replication-checker',
          capability: opts.capability?.name || 'replicationChecker',
          error: { code: 'INVALID_INPUT', message: 'runs, observations, or text is required' },
          data: {
            status: 'insufficient_input',
            source: 'replication-checker',
            capability: 'replicationChecker',
            output: {
              replicationStatus: 'uncertain',
              repeatCount: 0,
              consistency: 'insufficient',
              nextAction: 'experimentPlanner',
            },
            evidence: [],
            confidence: 0,
          },
          evidence: [],
          confidence: 0,
        };
      }

      const replicationStatus = repeatCount >= 2 ? 'replicable' : 'uncertain';
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(repeatCount >= 2 ? 0.66 : 0.44, 'docs')
        : (repeatCount >= 2 ? 0.66 : 0.44);
      const evidence = [{
        kind: 'replication',
        text: `repeatCount=${repeatCount}; status=${replicationStatus}`,
        confidence,
        source: 'replication-checker',
      }];

      return {
        ok: true,
        plugin: 'replication-checker',
        capability: opts.capability?.name || 'replicationChecker',
        data: {
          status: 'ready',
          source: 'replication-checker',
          capability: 'replicationChecker',
          output: {
            replicationStatus,
            repeatCount,
            consistency: repeatCount >= 2 ? 'stable' : 'insufficient',
            nextAction: repeatCount >= 2 ? 'discoveryEngine' : 'experimentPlanner',
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

module.exports = createReplicationCheckerPlugin();
module.exports.create = createReplicationCheckerPlugin;
