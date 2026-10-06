#!/usr/bin/env node
'use strict';

/**
 * huqan-neural-lab (#3474, I6).
 *
 * A bounded, offline B7 experiment runner: it trains the local SSM candidate on
 * the frozen inputs, measures quality/budget/locality against the declared
 * baselines, and prints one JSON report. It opens no store, makes no external
 * call and promotes nothing -- a KEEP is experimental only.
 *
 * Like huqan-causal-lab it refuses to measure when the frozen environment law
 * digest does not match the installed source, and it reports the caller's
 * declared Git SHA alongside the measured hashes of every source file it read,
 * so a reader can tell what was actually run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLocalNeuralModel } = require('../lib/cognitive-model-local-ssm');
const { createLocalRwkvModel } = require('../lib/cognitive-model-local-rwkv');
const { createLocalMambaModel } = require('../lib/cognitive-model-local-mamba');
const { createLocalTransformerModel } = require('../lib/cognitive-model-local-transformer');
const { runNeuralCognitionExperiment } = require('../lib/cognitive-lab-neural-experiment');
const { compareModelFamilies } = require('../lib/cognitive-lab-model-comparison');
const { DESIGN, FROZEN } = require('../lib/cognitive-lab-neural-design');
const { contentHash } = require('../lib/content-hash');

// The local families the port exposes, by the port's MODEL_KINDS name (#3561).
const FAMILIES = Object.freeze({
  SSM: createLocalNeuralModel,
  RWKV: createLocalRwkvModel,
  MAMBA: createLocalMambaModel,
  TRANSFORMER: createLocalTransformerModel,
});

const USAGE = 'huqan-neural-lab [--benchmark B7] [--model-kind <RWKV|MAMBA|SSM|TRANSFORMER> | --compare] --source-commit <40-character Git SHA> --source-dirty <true|false>';

const FILES = Object.freeze([
  'lib/cognitive-model-port.js',
  'lib/cognitive-model-local-primitives.js',
  'lib/cognitive-model-local-family.js',
  'lib/cognitive-model-local-ssm.js',
  'lib/cognitive-model-local-rwkv.js',
  'lib/cognitive-model-local-mamba.js',
  'lib/cognitive-model-local-transformer.js',
  'lib/cognitive-lab-neural-world.js',
  'lib/cognitive-lab-neural-design.js',
  'lib/cognitive-lab-neural-experiment.js',
  'lib/cognitive-lab-model-comparison.js',
  'bin/huqan-neural-lab.js',
]);

const MODEL_KINDS = Object.freeze(Object.keys(FAMILIES));

function parseArgs(args) {
  let rest = args[0] === '--benchmark' && args[1] === 'B7' ? args.slice(2) : args;
  let modelKind = 'SSM';
  let compare = false;
  if (rest[0] === '--model-kind') {
    if (!MODEL_KINDS.includes(rest[1])) throw new TypeError(`--model-kind must be one of ${MODEL_KINDS.join('|')}`);
    modelKind = rest[1];
    rest = rest.slice(2);
  } else if (rest[0] === '--compare') {
    compare = true;
    rest = rest.slice(1);
  }
  if (
    rest.length !== 4
    || rest[0] !== '--source-commit'
    || !/^[a-f0-9]{40}$/.test(rest[1])
    || rest[2] !== '--source-dirty'
    || !['true', 'false'].includes(rest[3])
  ) {
    throw new TypeError(`explicit ${USAGE.replace('huqan-neural-lab ', '')} required`);
  }
  return { sourceCommit: rest[1], sourceDirty: rest[3] === 'true', modelKind, compare };
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    return { usage: USAGE, scope: DESIGN.scope, benchmarks: { B7: DESIGN.scope }, modelKinds: [...MODEL_KINDS] };
  }
  const { sourceCommit, sourceDirty, modelKind, compare } = parseArgs(args);

  // Git converts line endings on Windows; the frozen law hashes normalized
  // UTF-8 source, while sourceFileHashes below report actual installed bytes.
  const worldSource = fs.readFileSync(path.join(__dirname, '..', 'lib/cognitive-lab-neural-world.js'), 'utf8').replace(/\r\n/g, '\n');
  if (contentHash(worldSource) !== FROZEN.worldDigest) throw new Error('frozen environment law digest mismatch');

  const result = compare
    ? compareModelFamilies({ models: FAMILIES, sourceCommit, sourceDirty })
    : runNeuralCognitionExperiment({ createModel: FAMILIES[modelKind], sourceCommit, sourceDirty });
  return {
    ...result,
    sourceEvidence: 'CALLER_DECLARED_GIT_SHA_WITH_MEASURED_FILE_HASHES',
    sourceFileHashes: Object.fromEntries(FILES.map((file) => [file, contentHash(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))])),
  };
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

module.exports = { main, FILES };
