const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeGitHubRepoUrl } = require('../lib/github-url');
const { fetchRepoFiles, fetchAndLearn, parseRepoUrl, includePath } = require('./github-adapter');

function makeResponse({ ok = true, status = 200, json, text, headers = {} }) {
  return {
    ok,
    status,
    json: async () => (typeof json === 'function' ? json() : json),
    text: async () => (typeof text === 'function' ? text() : text),
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
  };
}

test('github-adapter: parseRepoUrl parses owner/repo from url', () => {
  const parsed = parseRepoUrl('https://github.com/ai-ulu/axiom');
  assert.equal(parsed.owner, 'ai-ulu');
  assert.equal(parsed.repo, 'axiom');
});

test('github-adapter: canonicalizes GitHub repository URLs before use', () => {
  const parsed = parseRepoUrl('https://github.com/ai-ulu/axiom.git?token=secret#fragment');
  assert.deepEqual(parsed, { owner: 'ai-ulu', repo: 'axiom' });
  assert.equal(
    canonicalizeGitHubRepoUrl('https://github.com/ai-ulu/axiom.git?token=secret#fragment').repoUrl,
    'https://github.com/ai-ulu/axiom',
  );
  assert.throws(
    () => parseRepoUrl('https://user:secret@github.com/ai-ulu/axiom'),
    { code: 'REPO_URL_INVALID' },
  );
});

test('github-adapter: includePath keeps root md and .github docs', () => {
  assert.equal(includePath('README.md'), true);
  assert.equal(includePath('.github/workflows/release.md'), true);
  assert.equal(includePath('docs/intro.md'), false);
  assert.equal(includePath('src/index.js'), false);
});

test('github-adapter: fetchRepoFiles returns filtered markdown files', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/git/trees/')) {
      return makeResponse({
        json: {
          tree: [
            { type: 'blob', path: 'README.md' },
            { type: 'blob', path: 'CONTRIBUTING.md' },
            { type: 'blob', path: '.github/SECURITY.md' },
            { type: 'blob', path: 'docs/overview.md' },
            { type: 'blob', path: 'src/index.js' },
          ],
        },
      });
    }
    return makeResponse({
      text: '# content',
      headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });
  };

  const files = await fetchRepoFiles('https://github.com/ai-ulu/axiom', {
    branch: 'main',
    fetchImpl,
  });

  assert.equal(files.length, 3);
  assert.deepEqual(files.map(item => item.path).sort(), [
    '.github/SECURITY.md',
    'CONTRIBUTING.md',
    'README.md',
  ]);
  for (const item of files) {
    assert.deepEqual(Object.keys(item).sort(), [
      'branch',
      'content',
      'lastModified',
      'owner',
      'path',
      'repo',
    ]);
  }
  assert.equal(calls.some(url => url.includes('docs/overview.md')), false);
});

test('github-adapter: fetchRepoFiles surfaces rate-limit errors', async () => {
  const fetchImpl = async () => makeResponse({ ok: false, status: 403, json: {} });
  await assert.rejects(
    () => fetchRepoFiles('https://github.com/ai-ulu/axiom', { fetchImpl }),
    (err) => err && err.code === 'GITHUB_RATE_LIMIT'
  );
});

// fetchAndLearn had no coverage at all before #348's wiring change; these
// pin the contract it now depends on.

function singleFileFetchImpl() {
  return async (url) => {
    if (url.includes('/git/trees/')) {
      return makeResponse({ json: { tree: [{ type: 'blob', path: 'README.md' }] } });
    }
    return makeResponse({
      text: 'Kedi hayvandır',
      headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });
  };
}

test('github-adapter: fetchAndLearn ingests through learnAsync, not the sync path (#348)', async () => {
  const calls = [];
  const result = await fetchAndLearn('https://github.com/ai-ulu/axiom', {
    async learnAsync(text, opts) {
      calls.push({ text, opts });
      return { data: { learned: 2 } };
    },
    learn() { throw new Error('fetchAndLearn must not fall back to synchronous learn()'); },
  }, { branch: 'main', fetchImpl: singleFileFetchImpl(), paths: ['README.md'] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'Kedi hayvandır');
  assert.equal(calls[0].opts.provenance.source, 'github-adapter');
  assert.equal(calls[0].opts.sourceRef, 'ai-ulu/axiom/README.md@main');
  assert.deepEqual(result.learned, [{ path: 'README.md', learned: 2, ok: true }]);
});

test('github-adapter: fetchAndLearn reports a preIngest rejection per file instead of throwing (#348)', async () => {
  const result = await fetchAndLearn('https://github.com/ai-ulu/axiom', {
    async learnAsync() {
      throw Object.assign(new Error('source could not be reached'), { code: 'EVIDENCE_URL_UNREACHABLE' });
    },
  }, { branch: 'main', fetchImpl: singleFileFetchImpl(), paths: ['README.md'] });

  assert.equal(result.learned.length, 1);
  assert.equal(result.learned[0].ok, false);
  assert.match(result.learned[0].error, /could not be reached/);
});
