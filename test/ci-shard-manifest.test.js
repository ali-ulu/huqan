'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assignWeightedShards,
  discoverTestFiles,
  isTestFile,
} = require('../scripts/ci-shard-manifest');
const { parseArgs } = require('../scripts/run-test-shard');

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
  ]), {
    shard: 2,
    total: 3,
    concurrency: 2,
    report: '/tmp/shard-2.xml',
    list: false,
  });
});
