'use strict';

/**
 * Measure the cost of the Experience journal's durability class (#2915).
 *
 * The journal writes through `storage.withTransaction`, so its durability is
 * whatever `storage.db` was opened with. `lib/sqlite-durability.js` lists
 * `storage.js` as RESUMABLE -- a lost checkpoint tail costs repeated work --
 * but the journal is claimed to be the durable learning-history authority.
 *
 * `synchronous` is per-connection, so the choice is: raise `storage.db` to
 * EVIDENCE (and make every checkpoint fsync too), or give the journal its own
 * connection at EVIDENCE. This measures the append path under both settings so
 * the decision has a number rather than a ratio.
 *
 * Run: node scripts/measure-journal-durability.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const HuqanStorage = require('../storage');
const { createExperienceJournal } = require('../lib/experience/journal');

const APPENDS = 500;
const RUNS = 3;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-durability-'));
}

/** Drive real appends through the real journal and time the transaction. */
function measure(durability) {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'store.db') });
  try {
    storage.db.pragma(`synchronous = ${durability}`);
    const journal = createExperienceJournal({ store: storage });
    const runId = `run-${durability}`;
    journal.append({ runId, eventId: `${runId}:run_started`, type: 'run_started', workspaceId: 'default' });

    const samples = [];
    for (let i = 0; i < APPENDS; i += 1) {
      const start = process.hrtime.bigint();
      const result = journal.append({
        runId,
        eventId: `${runId}:step:${i}`,
        type: 'action_proposed',
        workspaceId: 'default',
        payload: { stepId: `s${i}`, action: 'ask', tool: 'ask', attempt: 1 },
      });
      const end = process.hrtime.bigint();
      if (!result.ok) throw new Error(`append refused: ${result.code}`);
      samples.push(Number(end - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return {
      median: samples[Math.floor(samples.length / 2)],
      p99: samples[Math.floor(samples.length * 0.99)],
      max: samples[samples.length - 1],
    };
  } finally {
    try { storage.db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The checkpoint path, to size the blast radius of raising storage.db. */
function measureCheckpoint(durability) {
  const dir = tempDir();
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'store.db') });
  try {
    storage.db.pragma(`synchronous = ${durability}`);
    const samples = [];
    for (let i = 0; i < APPENDS; i += 1) {
      const start = process.hrtime.bigint();
      storage.withTransaction(() => storage.saveCheckpoint({
        id: `cp-${i}`, goalKey: 'g', goal: 'g', state: { i }, iteration: i, budgetRemaining: 1,
      }));
      const end = process.hrtime.bigint();
      samples.push(Number(end - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return { median: samples[Math.floor(samples.length / 2)] };
  } finally {
    try { storage.db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = {};
for (const durability of ['NORMAL', 'FULL']) {
  const journalRuns = [];
  const checkpointRuns = [];
  for (let i = 0; i < RUNS; i += 1) {
    journalRuns.push(measure(durability));
    checkpointRuns.push(measureCheckpoint(durability));
  }
  results[durability] = {
    journalMedian: medianOf(journalRuns.map((r) => r.median)),
    journalP99: medianOf(journalRuns.map((r) => r.p99)),
    journalMax: Math.max(...journalRuns.map((r) => r.max)),
    checkpointMedian: medianOf(checkpointRuns.map((r) => r.median)),
  };
}

console.log(`journal append, ${APPENDS} appends x ${RUNS} runs, ms per append`);
console.log(`  NORMAL  median ${results.NORMAL.journalMedian.toFixed(3)}  p99 ${results.NORMAL.journalP99.toFixed(3)}  max ${results.NORMAL.journalMax.toFixed(3)}`);
console.log(`  FULL    median ${results.FULL.journalMedian.toFixed(3)}  p99 ${results.FULL.journalP99.toFixed(3)}  max ${results.FULL.journalMax.toFixed(3)}`);
console.log(`  ratio   ${(results.FULL.journalMedian / results.NORMAL.journalMedian).toFixed(2)}x median`);
console.log(`  delta   +${(results.FULL.journalMedian - results.NORMAL.journalMedian).toFixed(3)} ms per append`);
console.log('');
console.log('checkpoint write (the blast radius of raising storage.db), ms per write');
console.log(`  NORMAL  median ${results.NORMAL.checkpointMedian.toFixed(3)}`);
console.log(`  FULL    median ${results.FULL.checkpointMedian.toFixed(3)}`);
console.log(`  delta   +${(results.FULL.checkpointMedian - results.NORMAL.checkpointMedian).toFixed(3)} ms per checkpoint`);
