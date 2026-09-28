'use strict';

const {
  variable,
  constant,
  atom,
  createRule,
} = require('../lib/inference-rule-ir');
const { evaluateSemiNaive } = require('../lib/inference-semi-naive');

const SIZE = Number.parseInt(process.env.HUQAN_INFERENCE_BENCH_SIZE || '200', 10);
const X = variable('X');

function fact(predicate, value) {
  return atom(predicate, [constant(value)]);
}

const facts = Array.from({ length: SIZE }, (_, index) => fact('stage0', `item-${index}`));
const rules = [
  createRule({
    id: 'bench:stage1',
    head: atom('stage1', [X]),
    body: [atom('stage0', [X])],
  }),
  createRule({
    id: 'bench:stage2',
    head: atom('stage2', [X]),
    body: [atom('stage1', [X])],
  }),
  createRule({
    id: 'bench:stage3',
    head: atom('stage3', [X]),
    body: [atom('stage2', [X])],
  }),
];

const started = process.hrtime.bigint();
const result = evaluateSemiNaive(
  { facts, rules },
  { maxRounds: 8, maxOperations: Math.max(10000, SIZE * 50) },
);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

// For this unary chain, a naive evaluator that rescans every accumulated fact
// for every rule on every round has a simple lower-bound scan count. The
// semi-naive evaluator's later rounds are driven by their delta only.
const naiveFullRescanLowerBound = rules.length
  * result.deltas.reduce((accumulated, delta, roundIndex) => {
    const factsKnownAtRound = SIZE * (roundIndex + 1);
    return accumulated + factsKnownAtRound;
  }, 0);

const report = {
  benchmark: 'inference-semi-naive-unary-chain',
  size: SIZE,
  status: result.status,
  rounds: result.rounds,
  operations: result.operations,
  candidates: result.candidates.length,
  deltaSizes: result.deltas.map((delta) => delta.length),
  naiveFullRescanLowerBound,
  operationRatioVsNaiveLowerBound:
    naiveFullRescanLowerBound > 0
      ? Number((result.operations / naiveFullRescanLowerBound).toFixed(4))
      : 0,
  elapsedMs: Number(elapsedMs.toFixed(3)),
};

process.stdout.write(`${JSON.stringify(report)}\n`);

if (result.status !== 'fixpoint') process.exitCode = 1;
if (result.candidates.length !== SIZE * rules.length) process.exitCode = 1;
if (result.operations >= naiveFullRescanLowerBound) process.exitCode = 1;
