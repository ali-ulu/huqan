const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeGitHubRepoUrl, redactGitHubSourceRef } = require('./github-url');

test('canonicalizeGitHubRepoUrl keeps the existing strict repository contract', () => {
  assert.deepEqual(canonicalizeGitHubRepoUrl('https://github.com/owner/repo.git'), {
    owner: 'owner',
    repo: 'repo',
    repoUrl: 'https://github.com/owner/repo',
  });
  assert.throws(() => canonicalizeGitHubRepoUrl('http://github.com/owner/repo'), { code: 'REPO_URL_INVALID' });
  assert.throws(() => canonicalizeGitHubRepoUrl('https://user:secret@github.com/owner/repo'), { code: 'REPO_URL_INVALID' });
});

test('redactGitHubSourceRef canonicalizes supported GitHub transports without credentials or selectors', () => {
  const cases = [
    'https://user:ghp_SECRET@github.com/a/b/pull/1?token=secret#fragment',
    'http://user:ghp_SECRET@github.com/a/b/pull/1?token=secret#fragment',
    'git+https://user:ghp_SECRET@github.com/a/b/pull/1?token=secret#fragment',
    'ssh://git:ghp_SECRET@github.com/a/b/pull/1?token=secret#fragment',
    'https://user:ghp_SECRET@www.github.com/a/b/pull/1?token=secret#fragment',
  ];

  for (const value of cases) {
    assert.equal(redactGitHubSourceRef(value), 'https://github.com/a/b/pull/1');
  }
});

test('redactGitHubSourceRef preserves internal github refs but strips authority credentials and selectors', () => {
  assert.equal(
    redactGitHubSourceRef('github://user:ghp_SECRET@owner/repo/pull/1?token=secret#fragment'),
    'github://owner/repo/pull/1',
  );
  assert.equal(redactGitHubSourceRef('github://owner/repo/pull/1'), 'github://owner/repo/pull/1');
});

test('redactGitHubSourceRef fails closed for unsupported, opaque, malformed, and non-GitHub refs', () => {
  const cases = [
    'user:ghp_SECRET@github.com/a/b',
    'https://user:ghp_SECRET@example.com/a/b',
    'github:owner/repo',
    'not a url user:ghp_SECRET@github.com/a/b',
  ];

  for (const value of cases) {
    assert.equal(redactGitHubSourceRef(value), '');
  }
});
