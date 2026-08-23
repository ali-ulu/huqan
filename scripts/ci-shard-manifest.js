'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SHARDS = 3;
const DEFAULT_UNKNOWN_WEIGHT = 1;

// Historical wall-time weights from the last green 5,047-test run. Unknown
// files receive a conservative unit weight and are rebalanced on every run.
const HISTORICAL_WEIGHTS_SECONDS = Object.freeze({
  'test/v4-receipt-materialization-read-index.test.js': 25.314727,
  'test/stress-ingest-scale-smoke.test.js': 23.655566,
  'test/real-user-smoke-blockers.test.js': 14.695228,
  'test/v4-wb1-trust-receipt-inspector.test.js': 12.988540,
  'test/ui-claim-workspace-browser-smoke.test.js': 6.820305,
  'test/v5-c5-external-conformance.test.js': 5.581764,
  'test/reason-sandbox-isolation.test.js': 4.754675,
  'test/v4-b2b-ingest-approval-authority-gap.test.js': 2.339606,
  'test/memory-store-surface-audit.test.js': 1.206009,
  'test/sandbox-host-realm-escape.test.js': 0.850229,
});

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
    || base.startsWith('test-')
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

function weightFor(relativePath, weights = HISTORICAL_WEIGHTS_SECONDS) {
  const weight = Number(weights[relativePath]);
  return Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_UNKNOWN_WEIGHT;
}

function assignWeightedShards(files, shardCount = DEFAULT_SHARDS, weights = HISTORICAL_WEIGHTS_SECONDS) {
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

function getShard(files, shard, total, weights = HISTORICAL_WEIGHTS_SECONDS) {
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
  HISTORICAL_WEIGHTS_SECONDS,
  REPO_ROOT,
  assignWeightedShards,
  discoverTestFiles,
  getShard,
  isTestFile,
  weightFor,
};
