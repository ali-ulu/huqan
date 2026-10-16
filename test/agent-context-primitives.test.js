'use strict';

// Both sides of each branch in scripts/agent-context-primitives.js, driven
// directly. Through scripts/agent-context.js alone, which side runs depends on
// the checkout: a PR merge ref and a plain clone take different paths, so the
// coverage of this file used to move with the CI event, not with the code.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  contextConflict,
  normalizeGitHubRepository,
  readUtf8,
  repoRoot,
  runGit,
  sha256,
} = require('../scripts/agent-context-primitives');

test('normalizeGitHubRepository reads https and ssh remotes and rejects others', () => {
  assert.equal(normalizeGitHubRepository('https://github.com/ali-ulu/huqan.git'), 'ali-ulu/huqan');
  assert.equal(normalizeGitHubRepository('git@github.com:ali-ulu/huqan.git'), 'ali-ulu/huqan');
  assert.equal(normalizeGitHubRepository('https://github.com/ali-ulu/huqan'), 'ali-ulu/huqan');
  assert.equal(normalizeGitHubRepository('https://gitlab.com/ali-ulu/huqan.git'), null);
  assert.equal(normalizeGitHubRepository(''), null);
});

test('runGit returns trimmed output and throws on failure in both stderr modes', () => {
  assert.match(runGit(['rev-parse', '--is-inside-work-tree']), /^true$/);
  assert.throws(() => runGit(['rev-parse', '--verify', 'refs/heads/no-such-branch-for-this-test']));
  assert.throws(() => runGit(['rev-parse', '--verify', 'refs/heads/no-such-branch-for-this-test'], { allowFailure: true }));
});

test('readUtf8 normalises CRLF and trailing whitespace, sha256 is the hex digest', () => {
  const text = readUtf8(require.resolve('../package.json'));
  assert.equal(text.includes('\r\n'), false);
  assert.equal(text, text.trimEnd());
  assert.equal(sha256('huqan'), require('node:crypto').createHash('sha256').update('huqan', 'utf8').digest('hex'));
  assert.equal(typeof repoRoot, 'string');
});

test('contextConflict carries a stable code and prefix', () => {
  const error = contextConflict('baseline moved');
  assert.equal(error.code, 'CONTEXT_CONFLICT');
  assert.equal(error.message, 'CONTEXT_CONFLICT: baseline moved');
});
