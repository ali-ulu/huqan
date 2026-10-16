'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SHARDS = 3;
// Files the config treats as negligible get this instead of their measured
// time, so a shard of fast files still sorts against one slow file without the
// sum being dominated by hundreds of sub-second entries.
const DEFAULT_UNKNOWN_WEIGHT = 1;

/**
 * Per-file wall-time weights, read from config/shard-weights.json.
 *
 * These used to be a frozen literal in this file, described as "from the last
 * green run" and never updated. All but ten of the 1,045 test files therefore
 * took the default weight of 1, and the "weighted" assignment degenerated to
 * file-count balancing: measured against the real per-file times of run
 * 36109910520, the five shards that scheme produced carried
 * [61.5, 122.2, 134.0, 50.3, 120.2]s of work — 2.67x between the fastest and
 * slowest, with the critical path 36s above the 97.6s ideal. The measured
 * weights in the config bring that spread to 1.001.
 *
 * scripts/update-shard-weights.js regenerates the config from the nightly
 * test-timings artifacts. A missing or unreadable config falls back to the
 * unit weight, so a broken file degrades to file-count balancing rather than
 * failing the run.
 */
function loadShardWeights(configPath = path.join(REPO_ROOT, 'config', 'shard-weights.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const weights = parsed && parsed.weights;
    if (weights && typeof weights === 'object') return weights;
  } catch { /* missing config: fall through to the unit weight */ }
  return {};
}

const DEFAULT_SHARD_WEIGHTS = Object.freeze(loadShardWeights());

function isTestFile(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const base = path.posix.basename(normalized);
  if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) return false;
  if (normalized === '.git' || normalized.startsWith('.git/')) return false;
  if (normalized.startsWith('huqan-core/')) return false;
  if (normalized.startsWith('test/')) return base.endsWith('.js');
  return base.endsWith('.test.js')
    || base.endsWith('.spec.js')
    || base.endsWith('-test.js')
    || base.endsWith('_test.js')
    || base === 'test.js';
}

function walk(directory, relative = '') {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'huqan-core') continue;
      files.push(...walk(absolute, childRelative));
    } else if (entry.isFile() && isTestFile(childRelative)) {
      files.push(childRelative.split(path.sep).join('/'));
    }
  }
  return files;
}

function discoverTestFiles(root = REPO_ROOT) {
  return walk(root).sort();
}

function weightFor(relativePath, weights = DEFAULT_SHARD_WEIGHTS) {
  const weight = Number(weights[relativePath]);
  return Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_UNKNOWN_WEIGHT;
}

function assignWeightedShards(files, shardCount = DEFAULT_SHARDS, weights = DEFAULT_SHARD_WEIGHTS) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardCount must be a positive integer, got ${shardCount}`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('at least one test file is required');
  }

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    id: index + 1,
    weight: 0,
    files: [],
  }));

  const ranked = [...new Set(files)].sort((a, b) => {
    const difference = weightFor(b, weights) - weightFor(a, weights);
    return difference || a.localeCompare(b);
  });

  for (const file of ranked) {
    const target = shards.reduce((best, candidate) => candidate.weight < best.weight ? candidate : best);
    target.files.push(file);
    target.weight += weightFor(file, weights);
  }

  for (const shard of shards) shard.files.sort();
  return shards;
}

function getShard(files, shard, total, weights = DEFAULT_SHARD_WEIGHTS) {
  if (!Number.isInteger(shard) || shard < 1 || shard > total) {
    throw new Error(`shard must be between 1 and ${total}, got ${shard}`);
  }
  return assignWeightedShards(files, total, weights)[shard - 1];
}

if (require.main === module) {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }
  const total = Number(args.get('total') || DEFAULT_SHARDS);
  const files = discoverTestFiles();
  const shards = assignWeightedShards(files, total);
  for (const shard of shards) {
    console.log(`shard=${shard.id} weight=${shard.weight.toFixed(3)} files=${shard.files.length}`);
    for (const file of shard.files) console.log(`  ${file}`);
  }
}

module.exports = {
  DEFAULT_SHARDS,
  DEFAULT_UNKNOWN_WEIGHT,
  DEFAULT_SHARD_WEIGHTS,
  loadShardWeights,
  REPO_ROOT,
  assignWeightedShards,
  discoverTestFiles,
  getShard,
  isTestFile,
  weightFor,
};
