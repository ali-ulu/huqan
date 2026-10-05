#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { runCausalExperiment } = require('../lib/cognitive-lab-causal-experiment');
const { runWorldModelExperiment } = require('../lib/cognitive-lab-world-model-experiment');
const { DESIGN: WORLD_MODEL_DESIGN, FROZEN: WORLD_MODEL_FROZEN } = require('../lib/cognitive-lab-world-model-design');
const { contentHash } = require('../lib/content-hash');

const design = Object.freeze({
  "schemaVersion": "huqan-causal-experiment-v1",
  "sourceBase": "44765df877a9e1d3f3c007ab389100d20a5d6c55",
  "seed": 3468,
  "world": "bounded-door-v1",
  "scope": "Synthetic single-step discrete transitions; no external or general learning claim",
  "split": {
    "train": {
      "prefix": "train",
      "count": 48
    },
    "holdout": {
      "prefix": "holdout",
      "count": 160
    },
    "transfer": {
      "prefix": "transfer",
      "count": 160
    }
  },
  "transfer": "Unseen nuisance values and distinct episode/source ids; same causal law and frame",
  "budget": {
    "modelCalls": 0,
    "toolCalls": 0,
    "humanCalls": 0,
    "tokens": 0,
    "maxTrainingEpisodes": 512,
    "maxPredictionsPerCase": 4,
    "maxStateKeys": 8,
    "maxOperationsPerPrediction": 20000
  },
  "baseline": {
    "B2": "Persistence: predict the input state unchanged",
    "B3": "Choose cheapest receiver-policy-allowed action, without a learned model"
  },
  "thresholds": {
    "minimumSamplesPerSplit": 160,
    "minimumIndependentSupport": 3,
    "minimumAccuracyGain": 0.1,
    "minimumGoalReachGain": 0.1,
    "minimumGainLowerBound": 0.05,
    "maximumFalseCausalRuleRate": 0,
    "maximumUnsafeSelected": 0
  },
  "uncertainty": "Conservative bounded synthetic case score: mean(delta)-sqrt(2*log(20)/n); balanced strata, random nuisance and order; no real-task population CI claim",
  "metrics": {
    "B2": [
      "fullPostStateAccuracy",
      "pairedAccuracyGain",
      "falseCausalRuleRate",
      "unknownRate"
    ],
    "B3": [
      "goalReachRate",
      "meanExecutedCost",
      "unsafeRejections",
      "unsafeSelected",
      "pairedGoalReachGain"
    ]
  },
  "negativeControls": [
    "single episode",
    "correlated source duplicates",
    "observational confounder",
    "controlled null effect",
    "support withdrawal",
    "missing outcome",
    "budget exhaustion",
    "policy unavailable"
  ],
  "mutations": [
    "remove controlled comparison gate",
    "ignore support withdrawal",
    "disable learned simulator caller"
  ],
  "killCriteria": [
    "overlapping splits",
    "source hash mismatch",
    "policy bypass",
    "budget overrun",
    "missing measured usage",
    "any false causal effect",
    "lower bound below threshold"
  ],
  "promotion": "No automatic model or graph-rule promotion; KEEP is experimental only",
  "phase": "CONFIRMATORY_AFTER_EXPLORATORY",
  "fixtureDigest": "871213327106cc0e4c6266715fccfe271f69b69e2ac111073524a13cbd0eae49",
  "generatorDigest": "060ec3e1704739331544a4424f06de0f886c69e67803130b8aad996ceb030726",
  "worldDigest": "d1369398a0851564d378da2b30234530915928326c9a964bdea353de725a10a8"
});

// Reproduce the frozen confirmatory input fixture without shipping fixtures/**.
// runCausalExperiment checks design.fixtureDigest before any measurement, so a
// generator drift fails closed instead of silently changing the experiment.
function generateConfirmatoryDataset(seed = design.seed) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  function cases(prefix, count, start) {
    const entries = Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${seed}-${index}`,
      preState: {
        door: false,
        energized: index % 4 < 2,
        jammed: index % 2 === 0,
        nuisance: start + Math.floor(random() * 100000),
      },
      action: { name: 'unlock', args: {}, cost: 2 },
    }));
    for (let index = entries.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [entries[index], entries[swap]] = [entries[swap], entries[index]];
    }
    return entries;
  }
  return {
    train: cases('train', design.split.train.count, 0),
    splits: [
      { name: 'holdout', cases: cases('holdout', design.split.holdout.count, 100000) },
      { name: 'transfer', cases: cases('transfer', design.split.transfer.count, 1000000) },
    ],
  };
}

// R12 (B2/B3) stays the default run; `--benchmark B5` selects the R13 world
// model experiment (#3468). Each benchmark pins its own frozen environment law.
const BENCHMARKS = Object.freeze({
  B2B3: Object.freeze({
    world: 'lib/cognitive-lab-causal-world.js',
    worldDigest: design.worldDigest,
    scope: design.scope,
    run: options => runCausalExperiment({ ...options, design, dataset: generateConfirmatoryDataset() }),
    files: ['lib/causal/learned-causal-engine.js', 'lib/cognitive-lab-causal-experiment.js'],
  }),
  B5: Object.freeze({
    world: 'lib/cognitive-lab-world-model-world.js',
    worldDigest: WORLD_MODEL_FROZEN.worldDigest,
    scope: WORLD_MODEL_DESIGN.scope,
    run: options => runWorldModelExperiment(options),
    files: [
      'lib/causal/learned-causal-engine.js',
      'lib/causal/symbolic-world-model.js',
      'lib/cognitive-lab-world-model-design.js',
      'lib/cognitive-lab-world-model-experiment.js',
    ],
  }),
});
const USAGE = 'huqan-causal-lab [--benchmark B5] --source-commit <40-character Git SHA> --source-dirty <true|false>';

function parseArgs(args) {
  const selected = args[0] === '--benchmark' && args[1] === 'B5' ? 'B5' : 'B2B3';
  const rest = selected === 'B5' ? args.slice(2) : args;
  if (
    rest.length !== 4
    || rest[0] !== '--source-commit'
    || !/^[a-f0-9]{40}$/.test(rest[1])
    || rest[2] !== '--source-dirty'
    || !['true', 'false'].includes(rest[3])
  ) {
    throw new TypeError(`explicit ${USAGE.replace('huqan-causal-lab ', '')} required`);
  }
  return { benchmark: BENCHMARKS[selected], sourceCommit: rest[1], sourceDirty: rest[3] === 'true' };
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    return { usage: USAGE, scope: design.scope, benchmarks: { default: design.scope, B5: WORLD_MODEL_DESIGN.scope } };
  }
  const { benchmark, sourceCommit, sourceDirty } = parseArgs(args);

  // Git converts line endings on Windows. The frozen law hashes normalized
  // UTF-8 source, while sourceFileHashes below report actual installed bytes.
  const worldSource = fs
    .readFileSync(path.join(__dirname, '..', benchmark.world), 'utf8')
    .replace(/\r\n/g, '\n');
  if (contentHash(worldSource) !== benchmark.worldDigest) {
    throw new Error('frozen environment law digest mismatch');
  }

  const root = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(root, 'huqan-causal-lab-'));
  if (path.dirname(scratch) !== root || !path.basename(scratch).startsWith('huqan-causal-lab-')) {
    throw new Error('invalid private experiment path');
  }

  let graph;
  try {
    graph = new Graph({
      useSQLite: true,
      memoryPath: path.join(scratch, 'memory.json'),
      dbPath: path.join(scratch, 'memory.db'),
    });
    const journal = createExperienceJournal();
    const result = benchmark.run({
      graph,
      journal,
      createSimulator: (store, options) => new CausalSimulator(store, options),
      sourceCommit,
      sourceDirty,
    });
    const files = [
      'causalSimulator.js',
      'lib/causal/causal-episode-contract.js',
      'lib/causal/causal-runtime.js',
      benchmark.world,
      ...benchmark.files,
      'bin/huqan-causal-lab.js',
    ];
    return {
      ...result,
      sourceEvidence: 'CALLER_DECLARED_GIT_SHA_WITH_MEASURED_FILE_HASHES',
      sourceFileHashes: Object.fromEntries(
        files.map(file => [file, contentHash(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))]),
      ),
    };
  } finally {
    try {
      if (graph) graph.closeSqlite();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (['REJECT', 'INSUFFICIENT'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { generateConfirmatoryDataset, main };
