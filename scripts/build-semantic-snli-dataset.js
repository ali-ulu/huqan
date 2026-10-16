#!/usr/bin/env node
'use strict';

/**
 * R55 PR3 (#3717): builds a huqan-semantic-training-v1 dataset from SNLI 1.0 or
 * SNLI-TR 1.1 (both CC-BY-SA-4.0) for the v2 learner. Offline only; nothing is
 * fetched. Rules (docs/task-packs/semantic-model-data-r55.md):
 *
 * - Teacher: the human annotator label distribution of each row is ONE gold
 *   teacher, `human-annotators` (owner decision 2026-10-09). SNLI train rows
 *   usually carry only the writer's label; dev rows carry five validators.
 * - Splits follow the corpus: SNLI train -> `train`, SNLI dev -> `calibration`.
 *   SNLI test is never read, so it stays a clean benchmark.
 * - Rows without a gold label (`-`) or any usable annotator label are dropped;
 *   repeated text pairs keep their first occurrence. Both are counted.
 * - The R50 holdout check and the open-licence check are the dataset builder's.
 *
 * Usage: node scripts/build-semantic-snli-dataset.js <dir> <en|tr> <trainLimit> <calibrationLimit> <sourceCommit> <output.json>
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { digestOf, stableStringify } = require('./contradiction-eval-freeze-contract');
const { LABELS, HUMAN_ANNOTATORS_TEACHER_ID, textPairKey } = require('./semantic-teacher-contract');
const { buildTrainingDataset } = require('./semantic-training-dataset');

const CORPORA = Object.freeze({
  en: { language: 'en', prefix: 'snli_1.0', sourceId: 'snli-en', version: 'snli-1.0',
    url: 'https://nlp.stanford.edu/projects/snli/', attribution: 'SNLI 1.0, Bowman et al. 2015, Stanford NLP' },
  tr: { language: 'tr', prefix: 'snli_tr_1.1', sourceId: 'snli-tr', version: 'snli-tr-1.1',
    url: 'https://github.com/boun-tabi/NLI-TR', attribution: 'SNLI-TR 1.1, Budur et al. 2020, Bogazici University (translation of SNLI 1.0)' },
});
const ANNOTATOR_LABELS = Object.freeze({ contradiction: 'CONTRADICTION', entailment: 'ENTAILMENT', neutral: 'NEUTRAL' });
const MAX_TEXT = 2048;

function fail(code) { throw new TypeError(code); }

/**
 * The labels that describe THIS text pair. SNLI-TR 1.1 re-annotated a sample of
 * translated pairs (`translation_annotations`); where present, those judge the
 * Turkish text and win over the inherited English labels, and a `broken`
 * translation is dropped. Other rows keep the corpus-level labels.
 */
function pairLabels(row) {
  const translated = row.translation_annotations;
  if (translated && typeof translated === 'object') {
    if (translated.gold_label === 'broken') return { drop: 'translation_broken' };
    return { gold: translated.gold_label, votes: translated.annotator_labels };
  }
  return { gold: row.gold_label, votes: row.annotator_labels };
}

/** One SNLI row -> {record, teacher} or a drop reason. Pure. */
function adaptSnliRow(row, corpus, split) {
  if (!row) return { drop: 'no_gold_label' };
  const labels = pairLabels(row);
  if (labels.drop) return labels;
  if (!ANNOTATOR_LABELS[labels.gold]) return { drop: 'no_gold_label' };
  const premise = typeof row.sentence1 === 'string' ? row.sentence1.trim() : '';
  const hypothesis = typeof row.sentence2 === 'string' ? row.sentence2.trim() : '';
  if (!premise || !hypothesis || premise.length > MAX_TEXT || hypothesis.length > MAX_TEXT) return { drop: 'text_invalid' };
  const votes = (Array.isArray(labels.votes) ? labels.votes : []).map(label => ANNOTATOR_LABELS[label]).filter(Boolean);
  if (!votes.length) return { drop: 'no_annotator_label' };
  const input = { stored: { text: premise }, incoming: { text: hypothesis } };
  const distribution = Object.fromEntries(LABELS.map(label => [label, votes.filter(vote => vote === label).length / votes.length]));
  const caption = typeof row.captionID === 'string' && row.captionID ? row.captionID : digestOf(premise);
  return {
    record: { ...input, sourceId: corpus.sourceId, pairGroupId: `snli:${caption}`, split },
    teacher: { teacherId: HUMAN_ANNOTATORS_TEACHER_ID, teacherVersion: corpus.version, input, distribution, latencyMs: 0 },
  };
}

async function readSplit(file, corpus, split, limit, state) {
  const input = fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let kept = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { state.dropped.unparseable = (state.dropped.unparseable || 0) + 1; continue; }
      const adapted = adaptSnliRow(row, corpus, split);
      if (adapted.drop) { state.dropped[adapted.drop] = (state.dropped[adapted.drop] || 0) + 1; continue; }
      const key = textPairKey(adapted.record);
      if (state.seen.has(key)) { state.dropped.duplicate_pair = (state.dropped.duplicate_pair || 0) + 1; continue; }
      state.seen.add(key);
      state.records.push(adapted.record);
      state.teachers.push(adapted.teacher);
      if (++kept >= limit) break;
    }
  } finally {
    // rl.close() does not close its input; an early limit would leak the handle.
    rl.close();
    input.destroy();
  }
  return kept;
}

async function buildSnliDataset({ dir, language, trainLimit, calibrationLimit, sourceCommit, frozenCorpus }) {
  const corpus = CORPORA[language];
  if (!corpus) fail('snli_language_invalid');
  for (const limit of [trainLimit, calibrationLimit]) if (!Number.isSafeInteger(limit) || limit < 1) fail('snli_limit_invalid');
  const state = { records: [], teachers: [], seen: new Set(), dropped: {} };
  const train = await readSplit(path.join(dir, `${corpus.prefix}_train.jsonl`), corpus, 'train', trainLimit, state);
  const calibration = await readSplit(path.join(dir, `${corpus.prefix}_dev.jsonl`), corpus, 'calibration', calibrationLimit, state);
  const dataset = buildTrainingDataset({ records: state.records, teachers: state.teachers, frozenCorpus, sourceCommit,
    sources: [{ id: corpus.sourceId, license: 'CC-BY-SA-4.0', url: corpus.url, attribution: corpus.attribution }] });
  return { dataset, counts: { train, calibration, dropped: state.dropped } };
}

async function main(argv) {
  if (argv.length !== 6) fail('usage: build-semantic-snli-dataset.js <dir> <en|tr> <trainLimit> <calibrationLimit> <sourceCommit> <output.json>');
  const [dir, language, trainArg, calibrationArg, sourceCommit, output] = argv;
  const frozenCorpus = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json'), 'utf8')).records;
  const { dataset, counts } = await buildSnliDataset({ dir, language, trainLimit: Number(trainArg),
    calibrationLimit: Number(calibrationArg), sourceCommit, frozenCorpus });
  fs.writeFileSync(output, `${stableStringify(dataset)}\n`, { flag: 'wx' });
  return `${dataset.corpusDigest} ${JSON.stringify(counts)}`;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(line => process.stdout.write(`${line}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { CORPORA, adaptSnliRow, buildSnliDataset, main };
