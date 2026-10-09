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
 * Turkish: --language=tr reads SNLI-TR 1.1 (boun-tabi/NLI-TR, CC-BY-SA-4.0, the
 * same pairs machine-translated), so EN and TR are measured on aligned data.
 *
 * Usage: node scripts/benchmark-semantic-v2-snli.js <dir> [trainLimit=600000] [epochs=3] [--language=en|tr]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { encodeTextPair, tokenize } = require('../lib/semantic-model-text-features-v2');
const { LEARNED_LABELS } = require('../lib/semantic-model-artifact-v2');
const { scoresFor } = require('../lib/semantic-model-inference-v2');
const { createLogisticTrainer } = require('./train-semantic-model-v2');

// Same upper bound as the v2 artifact contract's config.epochs.
const MAX_EPOCHS = 50;
const FILES = Object.freeze({ en: split => `snli_1.0_${split}.jsonl`, tr: split => `snli_tr_1.1_${split}.jsonl` });
const GOLD = Object.freeze({ contradiction: 'CONTRADICTION', entailment: 'ENTAILMENT', neutral: 'NEUTRAL' });

function toExample(row, language = 'en') {
  const label = GOLD[row.gold_label];
  const premise = String(row.sentence1 || '');
  const hypothesis = String(row.sentence2 || '');
  if (!label || !premise.trim() || !hypothesis.trim() || premise.length > 2048 || hypothesis.length > 2048) return null;
  // Both arms must train and score on the same usable pairs. In particular,
  // hypothesis-only encoding never reads the premise, so punctuation-only
  // premises would otherwise enter only the baseline and distort the gain.
  // Filter before the stream counts this row toward the training limit.
  try {
    tokenize(premise, language);
    tokenize(hypothesis, language);
  } catch {
    return null;
  }
  return { record: { stored: { text: premise }, incoming: { text: hypothesis } }, y: LEARNED_LABELS.indexOf(label) };
}

async function* examples(file, limit, language) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let example = null;
      try { example = toExample(JSON.parse(line), language); } catch { example = null; }
      if (!example) continue;
      yield example;
      if (++count >= limit) break;
    }
  } finally {
    rl.close();
  }
}

function encode(record, hypothesisOnly, language) {
  try { return encodeTextPair(record, { language, hypothesisOnly }); } catch { return null; }
}

async function measure(dir, { hypothesisOnly, trainLimit, epochs, language = 'en' }) {
  const trainer = createLogisticTrainer();
  let trained = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for await (const { record, y } of examples(path.join(dir, FILES[language]('train')), trainLimit, language)) {
      const features = encode(record, hypothesisOnly, language);
      if (!features) continue;
      trainer.step(features, LEARNED_LABELS.map((_, k) => Number(k === y)), 1);
      if (epoch === 0) trained++;
    }
  }
  const weights = trainer.finish();
  const dimensions = weights.length / LEARNED_LABELS.length;
  let n = 0, correct = 0, truePositive = 0, predictedPositive = 0, goldPositive = 0;
  for await (const { record, y } of examples(path.join(dir, FILES[language]('test')), Infinity, language)) {
    const features = encode(record, hypothesisOnly, language);
    if (!features) continue;
    const scores = Array.from(scoresFor(weights, dimensions, features));
    const predicted = scores.indexOf(Math.max(...scores));
    n++;
    if (predicted === y) correct++;
    if (predicted === 0) predictedPositive++;
    if (y === 0) goldPositive++;
    if (predicted === 0 && y === 0) truePositive++;
  }
  if (trained === 0 || n === 0) throw new TypeError(`no usable ${trained === 0 ? 'training' : 'test'} pairs in ${dir}`);
  const round = value => Number(value.toFixed(4));
  return { trainPairs: trained, testPairs: n, accuracy: round(correct / n),
    contradictionRecall: round(truePositive / Math.max(1, goldPositive)),
    contradictionPrecision: round(truePositive / Math.max(1, predictedPositive)) };
}

async function main(argv) {
  const language = (argv.find(arg => arg.startsWith('--language=')) || '--language=en').slice('--language='.length);
  const [dir, limitArg, epochsArg] = argv.filter(arg => !arg.startsWith('--'));
  if (!Object.hasOwn(FILES, language)) throw new TypeError('language must be en or tr');
  if (!dir) throw new TypeError('usage: benchmark-semantic-v2-snli.js <snli_1.0 dir> [trainLimit] [epochs]');
  const trainLimit = Number(limitArg || 600000);
  const epochs = Number(epochsArg || 3);
  if (!Number.isSafeInteger(trainLimit) || trainLimit < 1) throw new TypeError('trainLimit must be a positive integer');
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > MAX_EPOCHS) throw new TypeError(`epochs must be an integer in 1..${MAX_EPOCHS}`);
  const full = await measure(dir, { hypothesisOnly: false, trainLimit, epochs, language });
  const hypothesisOnly = await measure(dir, { hypothesisOnly: true, trainLimit, epochs, language });
  return { dataset: language === 'tr' ? 'SNLI-TR 1.1 (CC-BY-SA-4.0)' : 'SNLI 1.0 (CC-BY-SA-4.0)', language, trainLimit, epochs, full, hypothesisOnly,
    crossSentenceGain: Number((full.accuracy - hypothesisOnly.accuracy).toFixed(4)) };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { toExample, measure, main };
