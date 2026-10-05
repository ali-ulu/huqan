'use strict';

// Run: node benchmarks/bench-retrieval-experiment.js [--k 5] [--seed 3462]
//        [--budget 150] [--repetitions 20] [--explain] [--no-latency]
// Prints the #3462 retrieval experiment report as JSON. Latency uses the
// process clock unless --no-latency is given, in which case it is reported
// NOT_MEASURED. Output is measurements, not a CI threshold.
const path = require('node:path');
const { loadFrozenCorpus, runExperiment } = require('./retrieval-experiment');

const CORPUS_PATH = path.join(__dirname, 'fixtures', 'retrieval-frozen-corpus.json');
const INTEGER_FLAGS = Object.freeze({ '--k': 'k', '--seed': 'seed', '--budget': 'budgetChars', '--repetitions': 'repetitions' });

function parseArgs(argv) {
  const opts = { repetitions: 20, clock: () => Number(process.hrtime.bigint()) / 1e6 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--explain') opts.explain = true;
    else if (flag === '--no-latency') delete opts.clock;
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
  const report = runExperiment(loadFrozenCorpus(CORPUS_PATH), parseArgs(argv));
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

module.exports = { CORPUS_PATH, parseArgs };
