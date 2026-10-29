'use strict';
// #4388 seeded M9 value-ledger holdout corpus generator (epic #4060).
//
// The M9 evaluator (#4063) scores the ledger's `success.p` forecast against a
// key-independent base rate, but it keeps the frozen corpus in the caller. This
// module is the missing seed-driven producer: a deterministic ledger corpus with
// disjoint train/calibration/holdout decisions, known-good and known-bad
// outcomes, and a fail-closed split audit. It mirrors the G1 corpus design
// (`lib/cognitive-lab-g1-corpus.js`): the seed fixes the corpus, the audit
// refuses a leaking one, and `corpusDigest` pins it into the calibration lock.
//
// Keys persist across splits and accumulate evidence; the split is per decision,
// exactly as the characterization fixture reads it. A key's earlier decisions
// are the only history a later decision may consume, so the corpus is the
// time-ordered predict-then-update surface the evaluator walks. `--emit` writes
// the evaluator request for the existing Lab CLI path
// (`value-ledger --value-ledger-records FILE`), so no caller hand-writes rows.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createPairedSampler: mulberry32 } = require('./cognitive-lab-paired-delta');

const M9_CORPUS_SCHEMA = 'huqan-m9-corpus-v1';
const M9_SEED = 20261029;
const WORKSPACE_ID = 'm9-holdout';
const SPLIT_ORDER = Object.freeze(['train', 'calibration', 'holdout']);
const SPLIT_ROWS = Object.freeze({ train: 24, calibration: 24, holdout: 24 });
// Fixed key reliability bands: a heterogeneous ledger is where a per-key
// forecast can differ from the key-independent base rate at all. The `uniform`
// anti-case profile collapses every key onto one rate, so the same measurement
// has no per-key signal to find and must not report a gain.
const RATE_BANDS = Object.freeze([0.9, 0.85, 0.8, 0.75, 0.7, 0.3, 0.25, 0.2, 0.15, 0.1]);
const UNIFORM_RATE = 0.5;
const NEGATIVE_OUTCOMES = Object.freeze(['rollback', 'reviewer-rejection', 'compensation', 'contradiction', 'incident']);
const BASE_MS = Date.UTC(2026, 9, 20, 0, 0, 0);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function fisherYates(list, rng) {
  for (let at = list.length - 1; at > 0; at -= 1) {
    const other = Math.floor(rng() * (at + 1));
    [list[at], list[other]] = [list[other], list[at]];
  }
  return list;
}

const ratesFor = profile => (profile === 'uniform' ? RATE_BANDS.map(() => UNIFORM_RATE) : [...RATE_BANDS]);

// One monotone wall clock across the whole corpus, in split order, so every
// train decision precedes every calibration decision precedes every holdout one.
function buildM9Corpus({ seed = M9_SEED, profile = 'heterogeneous' } = {}) {
  const rng = mulberry32(seed >>> 0);
  const keys = fisherYates(ratesFor(profile).map((rate, index) => ({ key: `key:${String(index).padStart(2, '0')}`, rate })), rng);
  let clock = 0;
  let group = 0;
  const splits = {};
  for (const split of SPLIT_ORDER) {
    splits[split] = [];
    for (const { key, rate } of keys) {
      for (let row = 0; row < SPLIT_ROWS[split]; row += 1) {
        clock += 2;
        const at = BASE_MS + clock * 1000;
        const outcome = rng() < rate ? 'confirmed' : pick(rng, NEGATIVE_OUTCOMES);
        splits[split].push({
          workspaceId: WORKSPACE_ID, key, decisionId: `d${String(clock).padStart(6, '0')}`,
          at: new Date(at).toISOString(), availableAt: new Date(at + 1000).toISOString(),
          outcome, sourceGroup: `g${group}`, sourceRefs: [`r${group}`], split,
        });
        group += 1;
      }
    }
  }
  return {
    schemaVersion: M9_CORPUS_SCHEMA, seed, profile, workspaceId: WORKSPACE_ID,
    protocol: { splitRows: { ...SPLIT_ROWS }, rateBands: [...RATE_BANDS], uniformRate: UNIFORM_RATE, splitOrder: [...SPLIT_ORDER] },
    splits, asOf: new Date(BASE_MS + (clock + 1000) * 1000).toISOString(),
  };
}

// Fail-closed split audit: decision ids are unique across the corpus, every
// decision is available at or after its own time, and no key's decisions appear
// out of split order, so a later decision can never be scored against its own
// future.
function auditSplits(corpus) {
  try {
    const seen = new Map();
    const leaks = [];
    const window = new Map();
    for (const split of SPLIT_ORDER) {
      for (const record of corpus.splits[split]) {
        const owner = seen.get(record.decisionId);
        if (owner && owner !== split) leaks.push({ decisionId: record.decisionId, splits: [owner, split] });
        if (!owner) seen.set(record.decisionId, split);
        if (Date.parse(record.availableAt) < Date.parse(record.at)) leaks.push({ decisionId: record.decisionId, reason: 'available_before_at' });
        const last = window.get(record.key);
        if (last && last.split !== split && SPLIT_ORDER.indexOf(last.split) > SPLIT_ORDER.indexOf(split)) {
          leaks.push({ key: record.key, splits: [last.split, split] });
        }
        window.set(record.key, { split, at: record.at });
      }
    }
    return leaks.length ? { status: 'LEAK', leaks } : { status: 'CLEAN', checked: seen.size };
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: error.message };
  }
}

function corpusDigest(corpus) {
  return sha256(canonical({ schemaVersion: corpus.schemaVersion, seed: corpus.seed, profile: corpus.profile,
    splits: Object.fromEntries(SPLIT_ORDER.map(split => [split, corpus.splits[split].map(record => record.decisionId)])) }));
}

// The evaluator request for one scored split: earlier decisions are history, the
// scored split is labelled `holdout` (the only split `walkForward` scores), and
// anything after it is withheld so the measurement cannot see the future.
// `limit` keeps only the first N decisions of the scored split, so the locked
// preregistered sample is scored exactly, not the whole split.
function m9Request(corpus, { scoreSplit = 'holdout', limit } = {}) {
  const at = SPLIT_ORDER.indexOf(scoreSplit);
  if (at < 0) throw new TypeError(`M9_UNKNOWN_SPLIT:${scoreSplit}`);
  const records = [];
  for (const split of SPLIT_ORDER.slice(0, at + 1)) {
    const rows = split === scoreSplit && limit !== undefined ? corpus.splits[split].slice(0, limit) : corpus.splits[split];
    for (const record of rows) records.push({ ...record, split: split === scoreSplit ? 'holdout' : split });
  }
  return { workspaceId: corpus.workspaceId, asOf: corpus.asOf, records };
}

module.exports = { M9_CORPUS_SCHEMA, M9_SEED, WORKSPACE_ID, SPLIT_ORDER, SPLIT_ROWS, RATE_BANDS, UNIFORM_RATE,
  NEGATIVE_OUTCOMES, buildM9Corpus, auditSplits, corpusDigest, m9Request, canonical, sha256 };

// `--emit <split> <out.json> [seed] [profile]` writes the request the existing
// Lab CLI scores, so the generator, not the caller, produces the rows.
if (require.main === module) {
  const [, , command, split, out, seed, profile] = process.argv;
  if (command !== '--emit' || !split || !out) {
    process.stderr.write('usage: node lib/cognitive-lab-m9-corpus.js --emit <split> <out.json> [seed] [profile]\n');
    process.exitCode = 2;
  } else {
    const corpus = buildM9Corpus({ seed: seed ? Number(seed) : M9_SEED, profile: profile || 'heterogeneous' });
    fs.writeFileSync(out, JSON.stringify(m9Request(corpus, { scoreSplit: split }), null, 2));
  }
}
