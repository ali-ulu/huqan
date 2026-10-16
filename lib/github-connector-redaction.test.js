const test = require('node:test');
const assert = require('node:assert/strict');
const { GITHUB_SOURCE_TYPES, normalizeGitHubItem } = require('./github-connector');

function makeItem(overrides = {}) {
  return {
    sourceSubType: GITHUB_SOURCE_TYPES.merged_pr,
    repo: 'owner/repo',
    number: 123,
    title: 'Credential redaction probe',
    actor: 'github:user',
    workspaceId: 'default',
    ...overrides,
  };
}

test('normalizeGitHubItem removes credentials across supported GitHub transport variants', () => {
  const cases = [
    'https://user:ghp_SECRET@github.com/owner/repo/pull/123?token=secret#fragment',
    'http://user:ghp_SECRET@github.com/owner/repo/pull/123?token=secret#fragment',
    'git+https://user:ghp_SECRET@github.com/owner/repo/pull/123?token=secret#fragment',
    'ssh://git:ghp_SECRET@github.com/owner/repo/pull/123?token=secret#fragment',
    'https://user:ghp_SECRET@www.github.com/owner/repo/pull/123?token=secret#fragment',
  ];

  for (const raw of cases) {
    const normalized = normalizeGitHubItem(makeItem({
      url: raw,
      sourceRef: raw,
      proposedEdge: { from: 'owner/repo', relation: 'reports', to: 'claim', sourceRef: raw },
    }));

    const expected = 'https://github.com/owner/repo/pull/123';
    assert.equal(normalized.url, expected);
    assert.equal(normalized.sourceRef, expected);
    assert.equal(normalized.proposedEdge.sourceRef, expected);
    assert.equal(JSON.stringify(normalized).includes('ghp_SECRET'), false);
    assert.equal(JSON.stringify(normalized).includes('token=secret'), false);
    assert.equal(JSON.stringify(normalized).includes('#fragment'), false);
  }
});

test('normalizeGitHubItem fails closed instead of persisting opaque or non-GitHub credential refs', () => {
  const cases = [
    'user:ghp_SECRET@github.com/owner/repo',
    'https://user:ghp_SECRET@example.com/owner/repo',
    'github:owner/repo',
    'not a url user:ghp_SECRET@github.com/owner/repo',
  ];

  for (const raw of cases) {
    const normalized = normalizeGitHubItem(makeItem({
      url: raw,
      sourceRef: raw,
      proposedEdge: { from: 'owner/repo', relation: 'reports', to: 'claim', sourceRef: raw },
    }));

    assert.equal(normalized.url, '');
    assert.equal(normalized.sourceRef, '');
    assert.equal(normalized.proposedEdge.sourceRef, '');
    assert.equal(JSON.stringify(normalized).includes('ghp_SECRET'), false);
  }
});

test('normalizeGitHubItem strips credentials from internal github refs', () => {
  const raw = 'github://user:ghp_SECRET@owner/repo/pull/123?token=secret#fragment';
  const normalized = normalizeGitHubItem(makeItem({
    sourceRef: raw,
    proposedEdge: { from: 'owner/repo', relation: 'reports', to: 'claim', sourceRef: raw },
  }));

  assert.equal(normalized.sourceRef, 'github://owner/repo/pull/123');
  assert.equal(normalized.proposedEdge.sourceRef, 'github://owner/repo/pull/123');
  assert.equal(JSON.stringify(normalized).includes('ghp_SECRET'), false);
});
