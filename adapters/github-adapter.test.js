const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchRepoFiles, parseRepoUrl, includePath } = require('./github-adapter');

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
  assert.equal(calls.some(url => url.includes('docs/overview.md')), false);
});

test('github-adapter: fetchRepoFiles surfaces rate-limit errors', async () => {
  const fetchImpl = async () => makeResponse({ ok: false, status: 403, json: {} });
  await assert.rejects(
    () => fetchRepoFiles('https://github.com/ai-ulu/axiom', { fetchImpl }),
    (err) => err && err.code === 'GITHUB_RATE_LIMIT'
  );
});
