#!/usr/bin/env node
'use strict';

/**
 * R55 PR2 (#3717): offline capacity benchmark for the v2 learner on SNLI 1.0
 * (CC-BY-SA-4.0; download it yourself, nothing is fetched here).
 *
 * Trains the shipped learner (scripts/train-semantic-model-v2.js) over the
 * shipped v2 features in file order, then reports test accuracy and
 * contradiction recall/precision for the full model AND the hypothesis-only
 * baseline, which R55 requires next to every number: SNLI annotation
 * artifacts let a premise-blind model score far above chance, so only the gap
 * between the two is evidence of cross-sentence reasoning. English only.
 * Streams the files, so memory stays at the weight arrays (~12 MB).
 *
 * Usage: node scripts/benchmark-semantic-v2-snli.js <snli_1.0 dir> [trainLimit=600000] [epochs=3]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { encodeTextPair } = require('../lib/semantic-model-text-features-v2');
const { LEARNED_LABELS } = require('../lib/semantic-model-artifact-v2');
const { scoresFor } = require('../lib/semantic-model-inference-v2');
const { createLogisticTrainer } = require('./train-semantic-model-v2');

const GOLD = Object.freeze({ contradiction: 'CONTRADICTION', entailment: 'ENTAILMENT', neutral: 'NEUTRAL' });

function toExample(row) {
  const label = GOLD[row.gold_label];
  const premise = String(row.sentence1 || '');
  const hypothesis = String(row.sentence2 || '');
  if (!label || !premise.trim() || !hypothesis.trim() || premise.length > 2048 || hypothesis.length > 2048) return null;
  return { record: { stored: { text: premise }, incoming: { text: hypothesis } }, y: LEARNED_LABELS.indexOf(label) };
}

async function* examples(file, limit) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let example = null;
      try { example = toExample(JSON.parse(line)); } catch { example = null; }
      if (!example) continue;
      yield example;
      if (++count >= limit) break;
    }
  } finally {
    rl.close();
  }
}

function encode(record, hypothesisOnly) {
  try { return encodeTextPair(record, { language: 'en', hypothesisOnly }); } catch { return null; }
}

async function measure(dir, { hypothesisOnly, trainLimit, epochs }) {
  const trainer = createLogisticTrainer();
  let trained = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for await (const { record, y } of examples(path.join(dir, 'snli_1.0_train.jsonl'), trainLimit)) {
      const features = encode(record, hypothesisOnly);
      if (!features) continue;
      trainer.step(features, LEARNED_LABELS.map((_, k) => Number(k === y)), 1);
      if (epoch === 0) trained++;
    }
  }
  const weights = trainer.finish();
  const dimensions = weights.length / LEARNED_LABELS.length;
  let n = 0, correct = 0, truePositive = 0, predictedPositive = 0, goldPositive = 0;
  for await (const { record, y } of examples(path.join(dir, 'snli_1.0_test.jsonl'), Infinity)) {
    const features = encode(record, hypothesisOnly);
    if (!features) continue;
    const scores = Array.from(scoresFor(weights, dimensions, features));
    const predicted = scores.indexOf(Math.max(...scores));
    n++;
    if (predicted === y) correct++;
    if (predicted === 0) predictedPositive++;
    if (y === 0) goldPositive++;
    if (predicted === 0 && y === 0) truePositive++;
  }
  const round = value => Number(value.toFixed(4));
  return { trainPairs: trained, testPairs: n, accuracy: round(correct / n),
    contradictionRecall: round(truePositive / Math.max(1, goldPositive)),
    contradictionPrecision: round(truePositive / Math.max(1, predictedPositive)) };
}

async function main(argv) {
  const [dir, limitArg, epochsArg] = argv;
  if (!dir) throw new TypeError('usage: benchmark-semantic-v2-snli.js <snli_1.0 dir> [trainLimit] [epochs]');
  const trainLimit = Number(limitArg || 600000);
  const epochs = Number(epochsArg || 3);
  const full = await measure(dir, { hypothesisOnly: false, trainLimit, epochs });
  const hypothesisOnly = await measure(dir, { hypothesisOnly: true, trainLimit, epochs });
  return { dataset: 'SNLI 1.0 (CC-BY-SA-4.0)', language: 'en', trainLimit, epochs, full, hypothesisOnly,
    crossSentenceGain: Number((full.accuracy - hypothesisOnly.accuracy).toFixed(4)) };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { toExample, measure, main };
