#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('./contradiction-eval-freeze-contract');
const { buildTrainingDataset } = require('./semantic-training-dataset');
const { adaptNliRows } = require('./semantic-nli-adapter');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function nliInput(sampleFile, teacherFile, sourceCommit) {
  const source = readJson(sampleFile);
  const teacher = readJson(teacherFile);
  const adapted = adaptNliRows(source.rows, { sourceId: 'snli', sourceVersion: '1.0' });
  return { records: adapted.records, teachers: [...adapted.teachers, ...teacher.outputs],
    sources: [{ id: 'snli', license: source.license, url: source.source, attribution: source.attribution }], sourceCommit };
}

function main(argv) {
  const nli = argv[0] === '--nli';
  if ((!nli && argv.length !== 2) || (nli && argv.length !== 5)) throw new TypeError('usage: build-semantic-training-dataset input.json output.json | --nli sample.json teacher.json sourceCommit output.json');
  const input = nli ? nliInput(argv[1], argv[2], argv[3]) : readJson(argv[0]);
  // The holdout authority is always the committed R50 corpus, never caller input.
  const frozenCorpus = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/contradiction-eval-v1.corpus.json'), 'utf8')).records;
  const dataset = buildTrainingDataset({ ...input, frozenCorpus });
  fs.writeFileSync(nli ? argv[4] : argv[1], `${stableStringify(dataset)}\n`, { flag: 'wx' });
  return dataset.corpusDigest;
}
if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { main };
