'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isPlainObject } = require('./is-plain-object');
const { openJournalConnection } = require('./experience/journal-connection');
const { readMutationJournal, readCommittedMutationResultsByPrefix } = require('./mutation-journal');
const { PAIR_OPERATION_PREFIX, PAIR_STORE_VERSION, OUTCOMES, readPredictionPairs } = require('./prediction-outcome-pairs');

const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0');
const instant = value => text(value) && Number.isFinite(Date.parse(value));
const sameFile = (a, b) => ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
function invalid(cause) {
  const error = new TypeError('invalid prediction source', { cause });
  error.code = 'INVALID_PREDICTION_SOURCE'; error.exitCode = 2;
  throw error;
}
function noLinks(file) {
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('prediction source is linked');
    if (current === path.dirname(current)) break;
  }
}
function noPending(file) {
  for (const suffix of ['-wal', '-shm', '-journal', '.redo.json']) {
    try { fs.lstatSync(`${file}${suffix}`); throw new Error('prediction source has pending sidecars'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function relevantRows(rows, workspaceId, now) {
  const selected = [];
  const predictions = new Map(), outcomes = new Map();
  for (const row of rows) {
    const source = row.result;
    if (source?.workspaceId !== workspaceId) continue;
    if (row.status !== 'completed' || !instant(row.committedAt) || Date.parse(row.committedAt) > now
      || !isPlainObject(source) || source.predictionPair !== true || source.storeVersion !== PAIR_STORE_VERSION
      || !text(source.decisionId) || source.decisionId.length > 128
      || !['runId', 'stepId', 'frameHash', 'expectationHash', 'sourceGroup'].every(key => text(source[key]))
      || !Array.isArray(source.sourceRefs) || !source.sourceRefs.length || source.sourceRefs.length > 8
      || !source.sourceRefs.every(text)) throw new Error('malformed scoped prediction row');
    const prediction = source.prediction, outcome = source.outcome;
    if (Boolean(prediction) === Boolean(outcome)) throw new Error('ambiguous prediction row');
    if (prediction) {
      if (!isPlainObject(prediction) || row.operationId !== `${PAIR_OPERATION_PREFIX}prediction:${source.decisionId}`
        || !(prediction.score === null ? text(prediction.unknown)
          : Number.isFinite(prediction.score) && prediction.score >= 0 && prediction.score <= 100 && prediction.unknown === '')
        || !(prediction.actionClass === null || text(prediction.actionClass))) throw new Error('malformed prediction');
    } else if (!isPlainObject(outcome) || !OUTCOMES.includes(outcome.state)
      || !row.operationId.startsWith(`${PAIR_OPERATION_PREFIX}outcome:`)) throw new Error('malformed outcome');
    const at = (prediction || outcome).at;
    if (!instant(at) || Date.parse(at) > Date.parse(row.committedAt)) throw new Error('prediction event follows commit');
    const events = prediction ? predictions : outcomes;
    if (events.has(source.decisionId)) throw new Error('duplicate prediction decision event');
    events.set(source.decisionId, row);
    selected.push(row);
  }
  for (const [id, outcome] of outcomes) {
    const prediction = predictions.get(id);
    if (!prediction || Date.parse(outcome.result.outcome.at) < Date.parse(prediction.result.prediction.at)
      || Date.parse(outcome.committedAt) < Date.parse(prediction.committedAt)) throw new Error('outcome precedes prediction');
  }
  return selected;
}

// A private snapshot only: no Graph constructor, schema initialization or recovery writes.
function openPredictionSource(file, { workspaceId, asOf } = {}) {
  let fd, connection;
  try {
    if (!text(file) || !text(workspaceId) || !instant(asOf)) throw new Error('prediction source scope is required');
    const absolute = path.resolve(file);
    fd = fs.openSync(absolute, 'r');
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('prediction source is not unique');
    const unchanged = () => {
      noLinks(absolute); noPending(absolute);
      if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))
        || !sameFile(before, fs.lstatSync(absolute, { bigint: true }))) throw new Error('prediction source changed');
    };
    unchanged();
    const bytes = fs.readFileSync(fd);
    unchanged();
    let reader;
    if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      connection = openJournalConnection({ dbPath: absolute, readOnly: true });
      if (!connection?.db) throw new Error('invalid SQLite prediction snapshot');
      const db = connection.db;
      reader = { _db: db, _stmts: {}, getCommittedMutationReceiptByOperation: () => null };
    } else {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'operations')) throw new Error('not a mutation journal');
      const journal = readMutationJournal(absolute, { existsSync: () => true, readFileSync: () => bytes.toString('utf8') });
      reader = { readJsonJournal: () => journal };
    }
    const all = relevantRows(readCommittedMutationResultsByPrefix(reader, PAIR_OPERATION_PREFIX), workspaceId, new Date().getTime());
    const snapshot = rows => ({ runMutationOnce() { throw new Error('read-only prediction snapshot'); },
      getCommittedMutationResultsByPrefix: () => rows });
    readPredictionPairs(snapshot(all));
    const rows = all.filter(row => Date.parse(row.committedAt) <= Date.parse(asOf));
    const pairs = readPredictionPairs(snapshot(rows));
    unchanged();
    return { rows, pairs };
  } catch (error) { invalid(error); }
  finally { connection?.close(); if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { openPredictionSource };
