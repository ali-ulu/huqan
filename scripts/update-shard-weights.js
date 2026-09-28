#!/usr/bin/env node
'use strict';

/**
 * Refresh config/shard-weights.json from the timings sidecars CI uploads.
 *
 * Why the loop exists: `ci-shard-manifest.js` assigns test files to shards by
 * weight, and the weights used to be a literal frozen in that file after one
 * run. Every later test file took the default weight of 1, so the assignment
 * fell back to balancing file counts. Measured against run 36109910520's real
 * per-file times, that produced five shards carrying
 * [61.5, 122.2, 134.0, 50.3, 120.2]s — the slowest 2.67x the fastest, and the
 * critical path 36s above the 97.6s ideal. Nothing fed the real times back, so
 * the imbalance could only grow as files were added.
 *
 * This reads each file's real wall time from the `timings` map in the shard
 * sidecar `run-test-shard.js` already writes beside its JUnit report
 * (`<report>-failures.json`) and regenerates the weights. The nightly
 * `refresh-shard-weights` job runs it and opens a PR when the numbers move;
 * a human merges it like any other change.
 *
 * Usage:
 *   node scripts/update-shard-weights.js [artifacts-dir] [--min=1.0] [--out=config/shard-weights.json] [--check]
 *
 * `--check` exits non-zero if the regenerated weights differ from the file on
 * disk, for use where a drift failure is wanted instead of a write.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MIN_WEIGHT_SECONDS = 1.0;

/**
 * Every shard sidecar under `root`, flattened.
 *
 * Recursive because CI uploads each sidecar as its own artifact and
 * `actions/download-artifact` with `merge-multiple` can place them directly or
 * under a per-artifact directory depending on the caller.
 */
function findTimingFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('test-') && entry.name.endsWith('-failures.json'))
    .map((entry) => path.join(entry.parentPath || root, entry.name))
    .sort();
}

/** Median of a non-empty numeric array; robust to one slow outlier run. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Merge every sidecar into `{ file: medianSeconds }`.
 *
 * A file can appear in more than one sidecar when several runs or attempts are
 * supplied; the median keeps a transiently slow run from inflating its weight
 * permanently.
 */
function collectTimings(paths) {
  const samples = new Map();
  for (const filePath of paths) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`could not read ${filePath}: ${error.message}`);
    }
    const timings = parsed && parsed.timings;
    if (!timings || typeof timings !== 'object') continue;
    for (const [file, seconds] of Object.entries(timings)) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) continue;
      if (!samples.has(file)) samples.set(file, []);
      samples.get(file).push(value);
    }
  }
  const merged = {};
  for (const [file, values] of samples) merged[file] = median(values);
  return merged;
}

/**
 * Weights above `minSeconds`, rounded, slowest first.
 *
 * Files at or below the threshold are dropped rather than written as their
 * measured value: they take the default unit weight anyway, and hundreds of
 * `0.014` entries would bloat a file whose useful content is the slow tail.
 */
function buildWeights(timings, minSeconds) {
  const kept = Object.entries(timings)
    .filter(([, seconds]) => seconds > minSeconds)
    .map(([file, seconds]) => [file, Math.round(seconds * 1000) / 1000]);
  kept.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(kept);
}

/**
 * Per-shard work if `files` were assigned by `weights`, for the summary.
 *
 * Mirrors `assignWeightedShards` (longest-processing-time first, next file to
 * the lightest shard) so the printed balance is the one the next run gets.
 */
function shardLoad(weights, files, shards) {
  const load = new Array(shards).fill(0);
  const ranked = [...files].sort((a, b) => (weights[b] || 1) - (weights[a] || 1) || (a < b ? -1 : 1));
  for (const file of ranked) {
    let target = 0;
    for (let index = 1; index < shards; index += 1) {
      if (load[index] < load[target]) target = index;
    }
    load[target] += weights[file] || 1;
  }
  return load;
}

function parseArgs(argv) {
  const options = { dir: null, min: DEFAULT_MIN_WEIGHT_SECONDS, out: path.join(REPO_ROOT, 'config', 'shard-weights.json'), check: false };
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) {
      if (match[1] === 'min') options.min = Number(match[2]);
      else if (match[1] === 'out') options.out = path.resolve(match[2]);
      else throw new Error(`unknown option --${match[1]}`);
    } else if (arg === '--check') {
      options.check = true;
    } else if (!options.dir) {
      options.dir = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (!Number.isFinite(options.min) || options.min < 0) throw new Error(`--min must be a non-negative number, got ${options.min}`);
  return options;
}

function buildDocument(timings, options) {
  const weights = buildWeights(timings, options.min);
  const files = Object.keys(timings);
  return {
    note: 'Per-file wall-time weights (seconds) measured on ubuntu-latest / Node 22. Consumed by scripts/ci-shard-manifest.js to balance CI shards. Refresh via scripts/update-shard-weights.js from the nightly test-timings artifacts; do not hand-edit.',
    measuredFrom: { workflow: 'Benchmark Regression', event: 'schedule' },
    minWeightSeconds: options.min,
    weights,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const dir = path.resolve(options.dir || path.join(REPO_ROOT, 'artifacts'));
  const timingFiles = findTimingFiles(dir);
  if (timingFiles.length === 0) {
    console.error(`no *-timings.json sidecars found under ${dir}`);
    return 2;
  }
  const timings = collectTimings(timingFiles);
  if (Object.keys(timings).length === 0) {
    console.error(`sidecars under ${dir} held no timings`);
    return 2;
  }
  const document = buildDocument(timings, options);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  const load = shardLoad(document.weights, Object.keys(timings), 5);
  const ideal = load.reduce((a, b) => a + b, 0) / load.length;
  console.log(`weighted ${timingFiles.length} sidecar file(s), ${Object.keys(document.weights).length} weights from ${Object.keys(timings).length} timed files`);
  console.log(`5-shard load: ${load.map((value) => value.toFixed(1)).join(', ')} (ideal ${ideal.toFixed(1)}, spread ${(Math.max(...load) / Math.min(...load)).toFixed(3)})`);

  if (options.check) {
    let current = '';
    try {
      current = fs.readFileSync(options.out, 'utf8');
    } catch { /* absent counts as drift */ }
    if (current !== serialized) {
      console.error(`${options.out} is out of date; run without --check to refresh it`);
      return 1;
    }
    console.log(`${options.out} is current`);
    return 0;
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, serialized);
  console.log(`wrote ${options.out}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_MIN_WEIGHT_SECONDS,
  buildDocument,
  buildWeights,
  collectTimings,
  findTimingFiles,
  main,
  median,
  parseArgs,
  shardLoad,
};
