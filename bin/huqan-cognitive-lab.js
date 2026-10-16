#!/usr/bin/env node
'use strict';

const Graph = require('../graph');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
const { readComparisonDesign } = require('../lib/cognitive-lab-comparison-store');

function readDesign(dbPath, runId) {
  // Even a readonly SQLite WAL connection can create -wal/-shm sidecars.
  // The caller holds the state lock; inspect a private copy (including a WAL
  // left by a crashed writer) before opening the supplied store for writing.
  const parent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(parent, 'huqan-cognitive-lab-read-'));
  if (path.dirname(scratch) !== parent || !path.basename(scratch).startsWith('huqan-cognitive-lab-read-')) throw new Error('invalid temporary read path');
  fs.chmodSync(scratch, 0o700);
  let db;
  try {
    const copy = path.join(scratch, 'memory.db');
    fs.copyFileSync(dbPath, copy, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, `${copy}-wal`, fs.constants.COPYFILE_EXCL);
    db = new Database(copy, { readonly: true, fileMustExist: true });
    const query = db.prepare('SELECT status, result FROM mutation_journal WHERE operation_id = ?');
    return readComparisonDesign({ getCommittedMutationResultByOperation(id) {
      const row = query.get(id);
      return row?.status === 'completed' ? { result: JSON.parse(row.result) } : null;
    } }, runId);
  } finally {
    try { if (db) db.close(); }
    finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

runCognitiveLab(process.argv.slice(2), { openGraph: options => new Graph(options), readDesign })
  .then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // A replay can succeed (`status: REPLAYED`) while the fail-closed gain
    // evaluator rejects the same measurement. The evaluator verdict is part of
    // the top-level result, so its REJECT must fail the process too.
    if (result.status === 'REJECT' || result.evaluation?.status === 'REJECT') process.exitCode = 1;
  })
  .catch(error => {
    process.stdout.write(`${JSON.stringify({ status: 'REJECT', assertsGain: false, intelligenceGain: 'NOT_MEASURED', error: error.message })}\n`);
    process.exitCode = 1;
  });
