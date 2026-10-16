'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  globToRegExp,
  matchesPattern,
  isRuntimeOrTestFile,
  readChangedFiles,
} = require('../scripts/ci-impact-plan-paths');

test('glob patterns treat **/ as any directory depth and ? as one path character', () => {
  assert.equal(matchesPattern('lib/a/b/c.js', 'lib/**/c.js'), true);
  assert.equal(matchesPattern('lib/c.js', 'lib/**/c.js'), true);
  assert.equal(matchesPattern('lib/c.ts', 'lib/c.?s'), true);
  assert.equal(matchesPattern('lib/c/s', 'lib/c?s'), false);
  assert.equal(globToRegExp('docs/*.md').test('docs/a/b.md'), false);
});

test('a test- prefixed script is impact-planned as runtime source, not as a test', () => {
  // The shard manifest no longer treats scripts/test-*.js as tests; the impact
  // plan must still route a change to it through the runtime/test path.
  assert.equal(isRuntimeOrTestFile('scripts/test-consumer-compile.js'), true);
  assert.equal(isRuntimeOrTestFile('test-root-helper.js'), true);
  assert.equal(isRuntimeOrTestFile('docs/test-notes.md'), false);
});

test('changed files come from git diff between two commits, normalized and sorted', () => {
  const files = readChangedFiles({ base: 'HEAD', head: 'HEAD' });
  assert.deepEqual(files, []);
  assert.deepEqual(readChangedFiles({ changedFiles: ['.\\b.js', './a.js', ''] }), ['a.js', 'b.js']);
});

test('changed-file discovery fails loudly on missing or unknown revisions', () => {
  assert.throws(() => readChangedFiles({}), /base and head are required/);
  assert.throws(() => readChangedFiles({ base: 'no-such-revision-3546', head: 'HEAD' }), /no-such-revision-3546|unknown revision|bad revision/);
});
