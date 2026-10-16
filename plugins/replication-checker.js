const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  return '';
}

/**
 * The runs whose agreement decides replication.
 *
 * `sourceRefs` is deliberately not one of these. A source reference list says
 * where a claim came from, not that anyone repeated it -- counting two sources
 * as two replications was a category error, so it is reported separately as
 * `sourceCount` and does not decide the verdict.
 */
function readRuns(input) {
  if (Array.isArray(input?.runs)) return input.runs;
  if (Array.isArray(input?.observations)) return input.observations;
  return [];
}

function readSourceCount(input) {
  return Array.isArray(input?.sourceRefs) ? input.sourceRefs.length : 0;
}

/**
 * Summarize what the runs actually said.
 *
 * The previous version counted array length and nothing else, so two runs that
 * contradicted each other, two identical runs, and two empty objects were all
 * reported as `replicable` / `stable`. Agreement is the thing this plugin
 * claims to measure, so it has to look at the outcomes.
 */
function summarizeRuns(runs) {
  const outcomes = runs
    .map((run) => (run && typeof run === 'object' ? run.outcome ?? run.signal ?? run.status : run))
    .map((value) => (value === undefined || value === null ? '' : String(value).trim()));
  const classified = outcomes.filter(Boolean);
  return { total: runs.length, classified: classified.length, distinct: new Set(classified).size };
}

/**
 * A run whose outcome cannot be read carries no evidence of repetition, so it
 * counts toward `total` but never toward agreement -- two empty objects stay
 * `insufficient` rather than becoming `stable`.
 */
function classifyReplication({ classified, distinct }) {
  if (classified < 2) return { replicationStatus: 'uncertain', consistency: 'insufficient' };
  if (distinct === 1) return { replicationStatus: 'replicable', consistency: 'stable' };
  return { replicationStatus: 'contradicted', consistency: 'conflicting' };
}

// Contradiction is worse evidence than a single run, not better: two runs that
// disagree used to raise confidence from 0.44 to 0.66, which points the wrong
// way and also routed the result to discovery instead of a new experiment.
const CONFIDENCE_BY_STATUS = Object.freeze({
  replicable: 0.66,
  uncertain: 0.44,
  contradicted: 0.2,
});

const NEXT_ACTION_BY_STATUS = Object.freeze({
  replicable: 'discoveryEngine',
  uncertain: 'experimentPlanner',
  contradicted: 'experimentPlanner',
});

function createReplicationCheckerPlugin() {
  return {
    name: 'replication-checker',
    version: '0.2.0',
    capabilities: [
      {
        name: 'replicationChecker',
        command: 'check-replication',
        description: 'Checks whether a discovery result is repeated, and whether the repeats agree.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      const runs = readRuns(input);
      const sourceCount = readSourceCount(input);
      const summary = summarizeRuns(runs);
      const repeatCount = summary.total || (text ? 1 : 0);

      if (!text && repeatCount === 0 && sourceCount === 0) {
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
              agreedCount: 0,
              distinctOutcomes: 0,
              sourceCount: 0,
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

      const { replicationStatus, consistency } = classifyReplication(summary);
      const baseConfidence = CONFIDENCE_BY_STATUS[replicationStatus];
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(baseConfidence, 'docs')
        : baseConfidence;
      const evidence = [{
        kind: 'replication',
        // The evidence text names what was measured. "repeatCount=2;
        // status=replicable" read as two agreeing repeats even when the two
        // runs contradicted each other.
        text: `repeatCount=${repeatCount}; classified=${summary.classified}; distinctOutcomes=${summary.distinct}; status=${replicationStatus}`,
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
            agreedCount: summary.classified,
            distinctOutcomes: summary.distinct,
            sourceCount,
            consistency,
            nextAction: NEXT_ACTION_BY_STATUS[replicationStatus],
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
