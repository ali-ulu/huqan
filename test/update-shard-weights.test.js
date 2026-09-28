'use strict';

/**
 * The shard-weight feedback loop (scripts/update-shard-weights.js).
 *
 * These cover the pure pieces — reading sidecars, median across runs, the
 * threshold, the load estimate — plus one end-to-end pass against a temp
 * directory, so a broken merge or a wrong threshold is caught without a real
 * CI run.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDocument,
  buildWeights,
  collectTimings,
  findTimingFiles,
  main,
  median,
  parseArgs,
  shardLoad,
} = require('../scripts/update-shard-weights');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-shard-weights-'));
}

test('median is stable against a single slow run', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 100]), 2.5);
});

test('timing sidecars are discovered recursively', () => {
  const directory = makeDir();
  try {
    fs.mkdirSync(path.join(directory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'a-timings.json'), '{}');
    fs.writeFileSync(path.join(directory, 'nested', 'b-timings.json'), '{}');
    fs.writeFileSync(path.join(directory, 'c.xml'), '<testsuites/>');
    const found = findTimingFiles(directory).map((file) => path.basename(file)).sort();
    assert.deepEqual(found, ['a-timings.json', 'b-timings.json']);
    assert.deepEqual(findTimingFiles(path.join(directory, 'absent')), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collectTimings merges sidecars and takes the median across runs', () => {
  const directory = makeDir();
  try {
    const first = path.join(directory, 'shard-1-timings.json');
    const second = path.join(directory, 'shard-2-timings.json');
    fs.writeFileSync(first, JSON.stringify({ timings: { 'test/a.test.js': 4, 'test/b.test.js': 0.2 } }));
    fs.writeFileSync(second, JSON.stringify({ timings: { 'test/a.test.js': 8, 'test/c.test.js': 1 } }));
    const merged = collectTimings([first, second]);
    assert.equal(merged['test/a.test.js'], 6);
    assert.equal(merged['test/b.test.js'], 0.2);
    assert.equal(merged['test/c.test.js'], 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collectTimings rejects a sidecar that is not readable json', () => {
  const directory = makeDir();
  try {
    const broken = path.join(directory, 'broken-timings.json');
    fs.writeFileSync(broken, '{ not json');
    assert.throws(() => collectTimings([broken]), /could not read/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildWeights drops sub-threshold files and orders the rest slowest first', () => {
  const weights = buildWeights(
    { 'test/fast.test.js': 0.1, 'test/slow.test.js': 30.12345, 'test/mid.test.js': 2, 'test/edge.test.js': 1 },
    1.0,
  );
  assert.deepEqual(Object.keys(weights), ['test/slow.test.js', 'test/mid.test.js']);
  assert.equal(weights['test/slow.test.js'], 30.123);
  assert.equal(weights['test/mid.test.js'], 2);
});

test('shardLoad spreads the slow tail instead of piling it onto one shard', () => {
  // One 30s file and four 1s files across 2 shards: the balanced outcome puts
  // the slow file alone on one shard and everything else on the other, not
  // both slow files together.
  const weights = { 'test/slow.test.js': 30 };
  const files = ['test/slow.test.js', 'test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
  const load = shardLoad(weights, files, 2);
  assert.deepEqual(load, [30, 4]);
  assert.equal(load.reduce((a, b) => a + b, 0), 34);
});

test('buildDocument carries the threshold and a do-not-hand-edit note', () => {
  const document = buildDocument({ 'test/slow.test.js': 9 }, { min: 2 });
  assert.equal(document.minWeightSeconds, 2);
  assert.match(document.note, /update-shard-weights\.js/);
  assert.deepEqual(document.weights, { 'test/slow.test.js': 9 });
});

test('parseArgs accepts a directory, threshold and output, and rejects junk', () => {
  assert.deepEqual(parseArgs(['artifacts', '--min=2', '--out=/tmp/w.json', '--check']), {
    dir: 'artifacts', min: 2, out: '/tmp/w.json', check: true,
  });
  assert.throws(() => parseArgs(['--min=-1']), /--min/);
  assert.throws(() => parseArgs(['--nope=1']), /unknown option/);
});

test('end to end: a directory of sidecars produces a weights document', () => {
  const directory = makeDir();
  try {
    fs.writeFileSync(path.join(directory, 'shard-1-timings.json'),
      JSON.stringify({ timings: { 'test/slow.test.js': 12, 'test/fast.test.js': 0.05 } }));
    fs.writeFileSync(path.join(directory, 'shard-2-timings.json'),
      JSON.stringify({ timings: { 'test/other.test.js': 3 } }));
    const out = path.join(directory, 'shard-weights.json');
    const status = main([directory, '--out=' + out]);
    assert.equal(status, 0);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(written.weights), ['test/slow.test.js', 'test/other.test.js']);
    assert.match(written.note, /shard-weights/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
