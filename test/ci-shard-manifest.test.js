'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assignWeightedShards,
  discoverTestFiles,
  isTestFile,
  loadShardWeights,
} = require('../scripts/ci-shard-manifest');
const { loadSelection, parseArgs } = require('../scripts/run-test-shard');

test('CI shard manifest follows Node test discovery without including helper scripts', () => {
  const files = discoverTestFiles();

  assert.ok(files.includes('test/ci-shard-manifest.test.js'));
  assert.ok(files.includes('test/helpers/cdp-browser.js'));
  assert.equal(files.includes('scripts/ci-shard-manifest.js'), false);
  assert.equal(files.includes('scripts/run-test-shard.js'), false);
  assert.equal(new Set(files).size, files.length);
  assert.equal(isTestFile('test/helpers/cdp-browser.js'), true);
  assert.equal(isTestFile('scripts/ci-shard-manifest.js'), false);
  assert.equal(isTestFile('artifacts/test-impact-plan.json'), false);
});

test('a test- prefixed build script or module outside test/ is not a shard test file', () => {
  // scripts/test-consumer-compile.js packs the tarball and runs tsc twice: on
  // Windows it took 44-92s and hit the 90s per-file kill on main (33c6c9f6).
  // Its own Consumer compile job already runs on every PR and main push.
  const files = discoverTestFiles();
  for (const file of ['scripts/test-consumer-compile.js', 'scripts/test-state-sandbox.js', 'lib/pilot/test-database-boundary.js']) {
    assert.equal(isTestFile(file), false, file);
    assert.equal(files.includes(file), false, file);
  }
  assert.equal(isTestFile('test/test-helper.js'), true);
  assert.equal(isTestFile('lib/foo-test.js'), true);
});

test('shard discovery and test selection agree on every tracked file', () => {
  const { isTestFile: isSelectedTestFile } = require('../scripts/ci-test-selection');
  const tracked = require('node:child_process').execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  // A selected file the shard runner does not know aborts the shard
  // ("selection manifest references unknown test files").
  const disagreements = tracked.filter((file) => isTestFile(file) !== isSelectedTestFile(file));
  assert.deepEqual(disagreements, []);
});

test('weighted shard assignment covers each file exactly once', () => {
  const files = ['fast.test.js', 'medium.test.js', 'slow.test.js', 'tiny.test.js'];
  const weights = { 'fast.test.js': 1, 'medium.test.js': 4, 'slow.test.js': 8, 'tiny.test.js': 1 };
  const shards = assignWeightedShards(files, 2, weights);
  const assigned = shards.flatMap((shard) => shard.files);

  assert.deepEqual([...assigned].sort(), [...files].sort());
  assert.equal(new Set(assigned).size, files.length);
  assert.deepEqual(shards.map((shard) => shard.weight), [8, 6]);
});

test('shard weights are loaded from the config, not frozen in the source', () => {
  // The weights used to be a literal in ci-shard-manifest.js, so every test
  // file added after the one run that produced it took the default unit
  // weight and the "weighted" sharding silently balanced file counts instead
  // of time (#measured in the loader comment).
  const repositoryWeights = loadShardWeights();

  assert.ok(Object.keys(repositoryWeights).length > 0, 'the repository config must carry real weights');
  assert.ok(repositoryWeights['test/stress-ingest-scale-smoke.test.js'] > 1,
    'the slowest measured file must keep a weight above the default');

  // A missing or malformed config degrades to the unit weight rather than
  // throwing, so a broken file cannot fail an unrelated shard run.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-shard-weights-'));
  try {
    assert.deepEqual(loadShardWeights(path.join(directory, 'absent.json')), {});
    const malformed = path.join(directory, 'malformed.json');
    fs.writeFileSync(malformed, '{ not json');
    assert.deepEqual(loadShardWeights(malformed), {});
    const noWeights = path.join(directory, 'no-weights.json');
    fs.writeFileSync(noWeights, JSON.stringify({ note: 'shape without weights' }));
    assert.deepEqual(loadShardWeights(noWeights), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runner parses explicit shard, concurrency and report options', () => {
  assert.deepEqual(parseArgs([
    '--shard=2',
    '--total=3',
    '--concurrency=2',
    '--report=/tmp/shard-2.xml',
    '--selection=/tmp/impact-plan.json',
  ]), {
    shard: 2,
    total: 3,
    concurrency: 2,
    report: '/tmp/shard-2.xml',
    selection: '/tmp/impact-plan.json',
    list: false,
  });
});

test('runner loads a validated selection and rejects unknown or empty files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-shard-selection-'));
  const validPath = path.join(directory, 'valid.json');
  const emptyPath = path.join(directory, 'empty.json');
  const unknownPath = path.join(directory, 'unknown.json');
  try {
    fs.writeFileSync(validPath, JSON.stringify({ schemaVersion: 1, selectedTests: ['test/a.test.js'] }));
    assert.deepEqual(loadSelection(validPath, ['test/a.test.js', 'test/b.test.js']), ['test/a.test.js']);
    fs.writeFileSync(emptyPath, JSON.stringify({ schemaVersion: 1, selectedTests: [] }));
    assert.throws(() => loadSelection(emptyPath, ['test/a.test.js']), /must not be empty/);
    fs.writeFileSync(unknownPath, JSON.stringify({ schemaVersion: 1, selectedTests: ['test/missing.test.js'] }));
    assert.throws(() => loadSelection(unknownPath, ['test/a.test.js']), /unknown test files/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
