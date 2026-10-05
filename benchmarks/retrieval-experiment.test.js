'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { corpusHash, loadFrozenCorpus, runExperiment, verifyFrozenCorpus } = require('./retrieval-experiment');
const { STRATEGIES } = require('./retrieval-experiment-strategies');
const { CORPUS_PATH, parseArgs } = require('./bench-retrieval-experiment');

const corpus = () => loadFrozenCorpus(CORPUS_PATH);

function fakeClock(step = 1) {
  let now = 0;
  return () => { now += step; return now; };
}

describe('retrieval experiment (#3462)', () => {
  describe('frozen corpus', () => {
    it('loads only when the pinned hash matches the content', () => {
      const frozen = corpus();
      assert.equal(frozen.frozen.sha256, corpusHash(frozen));
    });

    it('refuses a corpus whose content drifted from its pinned hash', () => {
      const drifted = corpus();
      drifted.queries[0].relevant = ['m01'];
      assert.throws(() => verifyFrozenCorpus(drifted), /frozen corpus hash mismatch/);
      assert.throws(() => runExperiment(drifted), /frozen corpus hash mismatch/);
    });
  });

  describe('default run', () => {
    it('reports unmeasured dimensions as NOT_MEASURED and carries no explain', () => {
      const report = runExperiment(corpus());
      assert.equal(report.scope, 'experiment-only');
      assert.equal(report.baseline.latency, 'NOT_MEASURED');
      assert.equal(report.candidate.latency, 'NOT_MEASURED');
      assert.equal(report.baseline.budget, 'NOT_MEASURED');
      assert.equal(report.comparison.latency, 'NOT_MEASURED');
      assert.equal(report.comparison.recallWithinBudget, 'NOT_MEASURED');
      assert.equal(Object.hasOwn(report, 'explain'), false);
    });

    it('pins baseline and candidate quality on the frozen corpus', () => {
      const { baseline, candidate, comparison } = runExperiment(corpus());
      assert.deepEqual([baseline.strategy, baseline.precisionAtK, baseline.recallAtK], ['substring-createdAt', 0.0222, 0.1111]);
      assert.deepEqual([candidate.strategy, candidate.precisionAtK, candidate.recallAtK], ['bm25-lexical', 0.2667, 1]);
      assert.equal(comparison.recallAtK.status, 'IMPROVED');
      assert.equal(comparison.precisionAtK.status, 'IMPROVED');
    });

    it('produces identical quality metrics for every seed', () => {
      const strip = ({ seed, ...rest }) => rest;
      assert.deepEqual(strip(runExperiment(corpus(), { seed: 1 })), strip(runExperiment(corpus(), { seed: 99 })));
    });
  });

  describe('budget', () => {
    it('measures recall of what fits in the character budget', () => {
      const { candidate, comparison } = runExperiment(corpus(), { budgetChars: 150 });
      assert.deepEqual(candidate.budget, { budgetChars: 150, meanUsedChars: 126.7778, recallWithinBudget: 0.8889, overBudgetQueries: 4 });
      assert.equal(comparison.recallWithinBudget.status, 'IMPROVED');
    });
  });

  describe('latency', () => {
    it('is measured only with an injected clock and is advisory', () => {
      const report = runExperiment(corpus(), { clock: fakeClock(), repetitions: 3 });
      assert.deepEqual(report.baseline.latency, { samples: 27, medianMs: 1, p95Ms: 1 });
      assert.deepEqual(report.comparison.latency, { baselineMedianMs: 1, candidateMedianMs: 1, status: 'ADVISORY' });
    });

    it('replays the same sample order for the same seed', () => {
      const calls = (seed) => {
        const order = [];
        const tracing = Object.fromEntries(Object.entries(STRATEGIES).map(([side, strategy]) => [side, {
          name: strategy.name,
          retrieve: (store, ws, text) => { order.push(`${side}:${text}`); return strategy.retrieve(store, ws, text); },
        }]));
        runExperiment(corpus(), { seed, clock: fakeClock(), strategies: tracing });
        return order;
      };
      assert.deepEqual(calls(7), calls(7));
      assert.notDeepEqual(calls(7), calls(8));
    });
  });

  describe('explain (opt-in)', () => {
    it('breaks each candidate hit into per-term BM25 contributions', () => {
      const { explain } = runExperiment(corpus(), { explain: true });
      const top = explain.candidate.q01[0];
      assert.equal(top.memoryId, 'm03');
      const sum = top.terms.reduce((acc, term) => acc + term.contribution, 0);
      assert.ok(Math.abs(sum - top.score) < 1e-5);
      assert.deepEqual(explain.baseline.q09, [{ memoryId: 'm04', matched: 'substring' }]);
    });

    it('never surfaces tombstoned or other-workspace decoys', () => {
      const { explain } = runExperiment(corpus(), { explain: true, k: 20 });
      const ids = Object.values(explain).flatMap((side) => Object.values(side).flat().map((hit) => hit.memoryId));
      assert.ok(ids.length > 0);
      assert.equal(ids.some((id) => id.startsWith('x-')), false);
    });
  });

  describe('fail-closed', () => {
    it('refuses a strategy that returns a memory outside the active workspace records', () => {
      const leaky = {
        name: 'leaky',
        retrieve: (store) => [{ record: store._memories.get(store.makeMemoryKey('lab', 'x-tombstoned')), explain: {} }],
      };
      assert.throws(() => runExperiment(corpus(), { strategies: { baseline: STRATEGIES.baseline, candidate: leaky } }),
        /leaky returned out-of-scope memory x-tombstoned for q01/);
    });

    it('refuses an allowed id carried by a record from another workspace or status', () => {
      for (const override of [{ workspaceId: 'other' }, { status: 'tombstoned' }]) {
        const forged = {
          name: 'forged',
          retrieve: (store) => [{ record: { ...store._memories.get(store.makeMemoryKey('lab', 'm03')), ...override }, explain: {} }],
        };
        assert.throws(() => runExperiment(corpus(), { strategies: { baseline: STRATEGIES.baseline, candidate: forged } }),
          /forged returned out-of-scope memory m03 for q01/);
      }
    });

    it('refuses a strategy that returns the same memory twice for one query', () => {
      const repeating = {
        name: 'repeating',
        retrieve: (store) => Array.from({ length: 5 }, () => ({ record: store._memories.get(store.makeMemoryKey('lab', 'm07')), explain: {} })),
      };
      assert.throws(() => runExperiment(corpus(), { strategies: { baseline: STRATEGIES.baseline, candidate: repeating } }),
        /repeating returned memory m07 twice for q01/);
    });

    for (const [opts, message] of [
      [{ k: 0 }, /k must be a positive integer/],
      [{ repetitions: 1.5 }, /repetitions must be a positive integer/],
      [{ seed: -1 }, /seed must be a non-negative integer/],
      [{ budgetChars: 0 }, /budgetChars must be a positive integer/],
      [{ clock: 5 }, /clock must be a function/],
    ]) {
      it(`rejects ${JSON.stringify(opts)}`, () => {
        assert.throws(() => runExperiment(corpus(), opts), message);
      });
    }
  });

  describe('runner arguments', () => {
    it('measures latency by default and drops the clock on --no-latency', () => {
      assert.equal(typeof parseArgs([]).clock, 'function');
      assert.equal(Object.hasOwn(parseArgs(['--no-latency']), 'clock'), false);
      assert.deepEqual({ ...parseArgs(['--k', '3', '--budget', '200', '--explain', '--no-latency']) },
        { repetitions: 20, k: 3, budgetChars: 200, explain: true });
    });

    it('rejects unknown and non-integer arguments', () => {
      assert.throws(() => parseArgs(['--fast']), /unknown argument: --fast/);
      assert.throws(() => parseArgs(['--k', 'many']), /--k needs an integer/);
      assert.throws(() => parseArgs(['--seed', '']), /--seed needs an integer/);
      assert.throws(() => parseArgs(['--seed', '  ']), /--seed needs an integer/);
      assert.throws(() => parseArgs(['--seed']), /--seed needs an integer/);
    });
  });
});
