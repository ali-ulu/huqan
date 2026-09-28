'use strict';

const {
  variable,
  constant,
  atom,
  createRule,
} = require('../lib/inference-rule-ir');
const {
  EVALUATION_STATUS,
  EVALUATION_STOPPED,
  evaluateSemiNaive,
} = require('../lib/inference-semi-naive');

const DEFAULT_NOISE_FACTS = 1000;
const DEFAULT_STAGES = 24;

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

function stageName(index) {
  return `stage_${String(index).padStart(2, '0')}`;
}

function buildReferenceFixture(opts = {}) {
  const noiseFacts = Number.isInteger(opts.noiseFacts)
    ? opts.noiseFacts
    : DEFAULT_NOISE_FACTS;
  const stages = Number.isInteger(opts.stages) ? opts.stages : DEFAULT_STAGES;

  if (noiseFacts < 0 || stages < 1) {
    throw new TypeError('noiseFacts must be >= 0 and stages must be >= 1');
  }

  const rules = [];
  for (let index = 0; index < stages; index += 1) {
    rules.push(createRule({
      id: `rule:stage:${String(index).padStart(2, '0')}`,
      head: atom(stageName(index + 1), [variable('X')]),
      body: [atom(stageName(index), [variable('X')])],
    }));
  }

  const facts = [fact(stageName(0), 'seed')];
  for (let index = 0; index < noiseFacts; index += 1) {
    facts.push(fact(`noise_${String(index).padStart(4, '0')}`, 'irrelevant'));
  }

  return { rules, facts, noiseFacts, stages };
}

function runReferenceBenchmark(opts = {}) {
  const fixture = buildReferenceFixture(opts);
  const result = evaluateSemiNaive(fixture.rules, fixture.facts, {
    timeoutMs: 10_000,
    maxOperations: 1_000_000,
    maxRounds: fixture.stages + 2,
  });

  const naiveFullRescanEstimate = result.stats.factCountsByRoundStart.reduce(
    (sum, factCount) => sum + (factCount * fixture.rules.length),
    0,
  );

  return Object.freeze({
    schema: 'huqan.inference-semi-naive-benchmark.v1',
    noiseFacts: fixture.noiseFacts,
    stages: fixture.stages,
    status: result.status,
    stoppedReason: result.stoppedReason,
    rounds: result.rounds,
    derivedFacts: result.derivedCandidates.length,
    driverFactVisits: result.stats.driverFactVisits,
    matchAttempts: result.stats.matchAttempts,
    naiveFullRescanEstimate,
    driverToNaiveRatio: naiveFullRescanEstimate > 0
      ? result.stats.driverFactVisits / naiveFullRescanEstimate
      : 0,
    deltaFactCounts: result.stats.deltaFactCounts,
    factCountsByRoundStart: result.stats.factCountsByRoundStart,
  });
}

function main() {
  const report = runReferenceBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const efficient = report.status === EVALUATION_STATUS.COMPLETE
    && report.stoppedReason === EVALUATION_STOPPED.FIXPOINT
    && report.derivedFacts === report.stages
    && report.driverFactVisits === report.stages
    && report.naiveFullRescanEstimate > report.driverFactVisits * 100;

  if (!efficient) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_NOISE_FACTS,
  DEFAULT_STAGES,
  buildReferenceFixture,
  runReferenceBenchmark,
};
