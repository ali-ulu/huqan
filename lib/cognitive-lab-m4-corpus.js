'use strict';

/**
 * #4070 COG-M4 Lab corpus
 * (`docs/task-packs/cog-m4-retention-preregistration-20261031.md` §4–§5).
 *
 * A seeded, deterministic synthetic corpus with group-level splits. Each group
 * is one `sourceGroup` whose memories are seeded with fixed importance, age and
 * use count, so the retention score is decided by the record's own fields and
 * not by a clock. "Needed" records are recent and important (kept by both
 * arms); "junk" records are old and unimportant (forgotten by the candidate
 * arm); a small deterministic fraction of groups also carry a "risk" record
 * that is needed yet forgettable, which is the only way recall can drop.
 *
 * The corpus is a controlled fixture: a GAIN label on it is a pipeline result,
 * not a production forgetting claim.
 */

const { createHash } = require('node:crypto');

const SCHEMA_VERSION = 'huqan-m4-corpus-v1';
const SEED = 40701;
// The measurement reference instant is a corpus constant, never Date.now(): the
// same corpus must produce the same report on every run and every platform.
const NOW = '2026-10-31T00:00:00.000Z';
const RECALL_K = 3;
const SPLIT_SIZES = Object.freeze({ calibration: 32, holdout: 32 });
const SPLITS = Object.freeze(['calibration', 'holdout']);
const NEEDED_PER_GROUP = 5;
const JUNK_PER_GROUP = 4;
// Every 8th group carries a risk record that is both needed and forgettable, so
// the recall loss is real but well inside the -0.05 non-inferiority margin.
const RISK_EVERY = 8;
const IMPORTANCE_SOURCE = 'declared-task-criticality';

const DAY_MS = 24 * 60 * 60 * 1000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]));
});

function memory({ id, token, importance, ageDays, uses }) {
  return {
    memoryId: id, token, importance, importanceSource: IMPORTANCE_SOURCE,
    ageDays, uses, pinned: false, dependencyProtected: false,
  };
}

function buildGroup(index, split) {
  const sourceGroup = `m4-g-${String(index).padStart(3, '0')}`;
  const memories = [];
  const queries = [];
  for (let slot = 0; slot < NEEDED_PER_GROUP; slot += 1) {
    const token = `m4-need-${sourceGroup}-i${slot}`;
    const id = `${sourceGroup}-need-${slot}`;
    memories.push(memory({ id, token, importance: 0.9, ageDays: 10, uses: 5 }));
    queries.push({ queryId: `${id}-q`, text: token, targetMemoryId: id, k: RECALL_K });
  }
  for (let slot = 0; slot < JUNK_PER_GROUP; slot += 1) {
    const token = `m4-junk-${sourceGroup}-j${slot}`;
    memories.push(memory({ id: `${sourceGroup}-junk-${slot}`, token, importance: 0.05, ageDays: 400, uses: 0 }));
  }
  // A risk record is both needed and forgettable: it is a query target yet its
  // low importance and age put it below the threshold, so the candidate arm
  // archives it and recall can drop. Only a deterministic fraction of groups
  // carry one, so the aggregate recall loss stays inside the margin.
  const risk = index % RISK_EVERY === 0;
  if (risk) {
    const riskToken = `m4-risk-${sourceGroup}`;
    const riskId = `${sourceGroup}-risk`;
    memories.push(memory({ id: riskId, token: riskToken, importance: 0.05, ageDays: 120, uses: 0 }));
    queries.push({ queryId: `${riskId}-q`, text: riskToken, targetMemoryId: riskId, k: RECALL_K });
  }
  return { sourceGroup, split, risk, memories, queries };
}

// Commits exactly the record fields the retention score is a function of, so a
// mutated corpus that would score differently can never share a digest.
const digestGroups = (groups) => sha256(canonical(groups.map((group) => [
  group.sourceGroup, group.split, group.risk,
  group.memories.map((item) => [item.memoryId, item.importance, item.ageDays, item.uses]),
  group.queries.map((query) => [query.queryId, query.targetMemoryId, query.k]),
])));

// Commits exactly the fields buildM4Corpus hashes, so a corpus object mutated
// after construction no longer matches the digest it carries. The evaluator
// recomputes with this rather than trusting the caller's `corpusDigest` field.
const digestCorpus = (corpus) => sha256(canonical({
  schemaVersion: corpus.schemaVersion, seed: corpus.seed, now: corpus.now,
  recallK: corpus.recallK, splitSizes: corpus.splitSizes, groups: corpus.groups,
}));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateSizes(splitSizes) {
  if (!splitSizes || typeof splitSizes !== 'object') throw new TypeError('M4_SPLIT_SIZES_INVALID');
  const sizes = {};
  for (const split of SPLITS) {
    const size = splitSizes[split];
    if (!Number.isInteger(size) || size < 1 || size > 512) throw new TypeError(`M4_SPLIT_SIZE_INVALID:${split}`);
    sizes[split] = size;
  }
  return sizes;
}

/**
 * @param {{seed?: number, splitSizes?: object}} options
 * @returns {Readonly<object>} deterministic corpus with corpusDigest/groupDigest
 */
function buildM4Corpus({ seed = SEED, splitSizes = SPLIT_SIZES } = {}) {
  if (!Number.isInteger(seed)) throw new TypeError('M4_SEED_INVALID');
  const sizes = validateSizes(splitSizes);
  const groups = [];
  let index = 0;
  for (const split of SPLITS) {
    for (let position = 0; position < sizes[split]; position += 1) {
      index += 1;
      groups.push(buildGroup(index, split));
    }
  }
  const corpus = { schemaVersion: SCHEMA_VERSION, seed, now: NOW, recallK: RECALL_K, splitSizes: { ...sizes }, groups: deepFreeze(groups) };
  return Object.freeze({ ...corpus, corpusDigest: digestCorpus(corpus), groupDigest: digestGroups(groups) });
}

const holdoutGroups = (corpus) => corpus.groups.filter((group) => group.split === 'holdout');
const createdAtFor = (ageDays, now = NOW) => new Date(Date.parse(now) - ageDays * DAY_MS).toISOString();

module.exports = {
  SCHEMA_VERSION, SEED, NOW, RECALL_K, SPLIT_SIZES, SPLITS, NEEDED_PER_GROUP, JUNK_PER_GROUP, RISK_EVERY,
  IMPORTANCE_SOURCE, sha256, canonical, digestGroups, digestCorpus, deepFreeze, buildM4Corpus, holdoutGroups, createdAtFor,
};
