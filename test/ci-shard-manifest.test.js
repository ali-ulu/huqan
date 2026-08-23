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
