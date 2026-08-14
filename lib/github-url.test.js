const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeGitHubRepoUrl,
  encodeGitHubPathSegments,
  buildGitHubBlobUrl,
  buildGitHubRawUrl,
  redactGitHubSourceRef,
} = require('./github-url');

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

// --- #690: a filename that is legal in Git must not steer the URL ---

test('encodeGitHubPathSegments escapes URL-significant characters and keeps the separators', () => {
  assert.equal(encodeGitHubPathSegments('notes#draft.md'), 'notes%23draft.md');
  assert.equal(encodeGitHubPathSegments('notes?draft.md'), 'notes%3Fdraft.md');
  assert.equal(encodeGitHubPathSegments('release notes.md'), 'release%20notes.md');
  assert.equal(encodeGitHubPathSegments('belgeler/özet.md'), 'belgeler/%C3%B6zet.md');
  // The separators survive: escaping them would collapse the path into one
  // segment and address a file that does not exist.
  assert.equal(encodeGitHubPathSegments('.github/ISSUE_TEMPLATE/bug.md'), '.github/ISSUE_TEMPLATE/bug.md');
  assert.equal(encodeGitHubPathSegments('docs\\adr\\ADR-1.md'), 'docs/adr/ADR-1.md');
});

test('buildGitHubBlobUrl and buildGitHubRawUrl canonicalize one path the same way (#690)', () => {
  const commit = 'c'.repeat(40);
  for (const path of ['notes#draft.md', 'notes?draft.md', 'release notes.md', 'belgeler/özet.md']) {
    const blobUrl = buildGitHubBlobUrl({ owner: 'acme', repo: 'repo', branch: commit, path });
    const rawUrl = buildGitHubRawUrl({ owner: 'acme', repo: 'repo', ref: commit, path });

    const encoded = encodeGitHubPathSegments(path);
    assert.equal(blobUrl, `https://github.com/acme/repo/blob/${commit}/${encoded}`);
    assert.equal(rawUrl, `https://raw.githubusercontent.com/acme/repo/${commit}/${encoded}`);

    // The whole path stays in the request path: nothing leaks into the query
    // or the fragment, where it would never reach the server.
    const parsedRaw = new URL(rawUrl);
    assert.equal(parsedRaw.search, '');
    assert.equal(parsedRaw.hash, '');
    assert.equal(decodeURIComponent(parsedRaw.pathname), `/acme/repo/${commit}/${path}`);
  }
});

test('buildGitHubRawUrl refuses an incomplete reference', () => {
  assert.throws(
    () => buildGitHubRawUrl({ owner: 'acme', repo: 'repo', ref: '', path: 'README.md' }),
    { code: 'REPO_URL_INVALID' },
  );
  assert.throws(
    () => buildGitHubRawUrl({ owner: 'acme', repo: 'repo', ref: 'main', path: '' }),
    { code: 'REPO_URL_INVALID' },
  );
});
