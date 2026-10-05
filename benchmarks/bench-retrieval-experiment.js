'use strict';

// Run: node benchmarks/bench-retrieval-experiment.js [--corpus small|github]
//        [--k 5] [--seed 3462] [--budget 150] [--repetitions 20] [--explain]
//        [--no-latency]
// small  - hand-written, 9 queries: shows the harness and its decoys work.
// github - last 1000 merged huqan PRs, 408 issue-title queries with relevance
//          taken from GitHub's closing links (build-retrieval-github-corpus.js).
// Prints the #3462 retrieval experiment report as JSON. Latency uses the
// process clock unless --no-latency is given, in which case it is reported
// NOT_MEASURED. Output is measurements, not a CI threshold.
const path = require('node:path');
const { loadFrozenCorpus, runExperiment } = require('./retrieval-experiment');

const CORPORA = Object.freeze({
  small: path.join(__dirname, 'fixtures', 'retrieval-frozen-corpus.json'),
  github: path.join(__dirname, 'fixtures', 'retrieval-github-corpus.json'),
});
const CORPUS_PATH = CORPORA.small;
const INTEGER_FLAGS = Object.freeze({ '--k': 'k', '--seed': 'seed', '--budget': 'budgetChars', '--repetitions': 'repetitions' });

function parseArgs(argv) {
  const opts = { corpus: 'small', repetitions: 20, clock: () => Number(process.hrtime.bigint()) / 1e6 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--explain') opts.explain = true;
    else if (flag === '--no-latency') delete opts.clock;
    else if (flag === '--corpus') {
      opts.corpus = argv[++i];
      if (!Object.hasOwn(CORPORA, opts.corpus)) throw new Error(`--corpus must be one of: ${Object.keys(CORPORA).join(', ')}`);
    }
    else if (INTEGER_FLAGS[flag]) {
      const raw = argv[++i];
      // Number('') is 0, so a missing or blank operand must be refused before conversion.
      if (raw === undefined || raw.trim() === '' || !Number.isInteger(Number(raw))) {
        throw new Error(`${flag} needs an integer`);
      }
      opts[INTEGER_FLAGS[flag]] = Number(raw);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return opts;
}

function main(argv) {
  const { corpus, ...opts } = parseArgs(argv);
  const report = runExperiment(loadFrozenCorpus(CORPORA[corpus]), opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`retrieval experiment refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { CORPORA, CORPUS_PATH, parseArgs };
