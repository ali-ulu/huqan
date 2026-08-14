const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');
const evidenceValidator = require('../plugins/evidence-validator');
const { canonicalizeGitHubRepoUrl } = require('../lib/github-url');
const { fetchRepoFiles, fetchAndLearn, parseRepoUrl, includePath } = require('./github-adapter');

const TEST_COMMIT_SHA = 'c'.repeat(40);

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
    if (/\/commits\/[^/?]+$/.test(url)) {
      // The adapter resolves the ref to a commit before reading anything, so a
      // stub that does not answer this is not standing in for GitHub.
      return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    }
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
      'commitSha',
      'content',
      'lastModified',
      'owner',
      'path',
      'repo',
    ]);
    assert.equal(item.commitSha, TEST_COMMIT_SHA);
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
    if (/\/commits\/[^/?]+$/.test(url)) {
      // The adapter resolves the ref to a commit before reading anything, so a
      // stub that does not answer this is not standing in for GitHub.
      return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    }
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
  assert.equal(calls[0].opts.sourceRef, `https://github.com/ai-ulu/axiom/blob/${TEST_COMMIT_SHA}/README.md`);
  assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
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

// --- #591: the reachability gate must actually see GitHub-sourced content ---
//
// The tests above use a stub kernel, which is why the compact
// `owner/repo/path@branch` sourceRef could regress past CI: nothing there
// exercises the real evidence-validator, and its reachability gate ignores any
// sourceRef that is not an http(s) URL. These use a real Kernel with the real
// plugin so the probe itself is the evidence.

function reachabilityKernel(fetchUrl) {
  // loadPlugins:false so the on-disk evidence-validator does not claim the
  // name first and make register() dedupe away the fetch-injected copy.
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register({
    ...evidenceValidator,
    preIngest: evidenceValidator.createPreIngest({ fetchUrl }),
  });
  k.enableCapability('evidenceReachability');
  return k;
}

test('github-adapter: fetchAndLearn runs the real evidenceReachability probe (#591)', async () => {
  const probes = [];
  const kernel = reachabilityKernel(async (url, options) => {
    probes.push({ url, options });
    return { statusCode: 200 };
  });

  await fetchAndLearn('https://github.com/ai-ulu/axiom', kernel, {
    branch: 'main',
    fetchImpl: singleFileFetchImpl(),
    paths: ['README.md'],
  });

  assert.equal(probes.length, 1, 'remote GitHub content must be probed, not waved through');
  assert.equal(probes[0].url, `https://github.com/ai-ulu/axiom/blob/${TEST_COMMIT_SHA}/README.md`);
  assert.equal(probes[0].options.method, 'HEAD');
});

test('github-adapter: an unreachable GitHub source fails closed before mutation (#591)', async () => {
  const kernel = reachabilityKernel(async () => ({ statusCode: 404 }));
  let learnEntered = false;
  const realLearn = kernel.learn.bind(kernel);
  kernel.learn = (...args) => { learnEntered = true; return realLearn(...args); };

  const result = await fetchAndLearn('https://github.com/ai-ulu/axiom', kernel, {
    branch: 'main',
    fetchImpl: singleFileFetchImpl(),
    paths: ['README.md'],
  });

  assert.equal(result.learned[0].ok, false);
  assert.match(result.learned[0].error, /HTTP 404/);
  assert.equal(learnEntered, false, 'the mutation path must not be entered once the probe fails');
});

test('github-adapter: with the capability off the probe is never spent (#591)', async () => {
  let probed = false;
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  kernel.plugins.register({
    ...evidenceValidator,
    preIngest: evidenceValidator.createPreIngest({
      fetchUrl: async () => { probed = true; return { statusCode: 200 }; },
    }),
  });

  await fetchAndLearn('https://github.com/ai-ulu/axiom', kernel, {
    branch: 'main',
    fetchImpl: singleFileFetchImpl(),
    paths: ['README.md'],
  });

  assert.equal(probed, false, 'offline default must stay offline');
});

// --- #689: a truncated tree is a partial tree, not a small repository ---

test('github-adapter: a truncated recursive tree is completed by walking subtrees (#689)', async () => {
  const treeCalls = [];
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      treeCalls.push(url);
      if (url.includes('recursive=1')) {
        // What GitHub returns for a large repository: a real prefix of the
        // tree, flagged, with the rest missing.
        return makeResponse({ json: { truncated: true, tree: [{ type: 'blob', path: 'README.md' }] } });
      }
      if (url.includes('/git/trees/dotgithub')) {
        return makeResponse({
          json: {
            tree: [
              { type: 'blob', path: 'SECURITY.md' },
              { type: 'tree', path: 'ISSUE_TEMPLATE', sha: 'templates' },
            ],
          },
        });
      }
      if (url.includes('/git/trees/templates')) {
        return makeResponse({ json: { tree: [{ type: 'blob', path: 'bug.md' }] } });
      }
      return makeResponse({
        json: {
          tree: [
            { type: 'blob', path: 'README.md' },
            { type: 'blob', path: 'CONTRIBUTING.md' },
            { type: 'tree', path: '.github', sha: 'dotgithub' },
            { type: 'tree', path: 'docs', sha: 'docs-tree' },
          ],
        },
      });
    }
    return makeResponse({ text: '# content' });
  };

  const files = await fetchRepoFiles('https://github.com/ai-ulu/axiom', { branch: 'main', fetchImpl });

  // Before the fix this returned exactly ['README.md'] and reported success.
  assert.deepEqual(files.map(item => item.path).sort(), [
    '.github/ISSUE_TEMPLATE/bug.md',
    '.github/SECURITY.md',
    'CONTRIBUTING.md',
    'README.md',
  ]);
  // The walk enters only subtrees that can still hold an includable path, so
  // `docs` is never requested even though the root listed it.
  assert.equal(treeCalls.some(url => url.includes('docs-tree')), false);
});

test('github-adapter: a truncated recursive tree walks only the subtrees explicit paths name (#689)', async () => {
  const treeCalls = [];
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      treeCalls.push(url);
      if (url.includes('recursive=1')) {
        return makeResponse({ json: { truncated: true, tree: [] } });
      }
      if (url.includes('/git/trees/docs-tree')) {
        return makeResponse({ json: { tree: [{ type: 'blob', path: 'overview.md' }] } });
      }
      return makeResponse({
        json: {
          tree: [
            { type: 'tree', path: 'docs', sha: 'docs-tree' },
            { type: 'tree', path: '.github', sha: 'dotgithub' },
          ],
        },
      });
    }
    return makeResponse({ text: '# content' });
  };

  const files = await fetchRepoFiles('https://github.com/ai-ulu/axiom', {
    branch: 'main',
    fetchImpl,
    paths: ['docs/overview.md'],
  });

  assert.deepEqual(files.map(item => item.path), ['docs/overview.md']);
  assert.equal(treeCalls.some(url => url.includes('dotgithub')), false);
});

test('github-adapter: a truncated subtree fails closed instead of returning a short list (#689)', async () => {
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      if (url.includes('recursive=1')) {
        return makeResponse({ json: { truncated: true, tree: [{ type: 'blob', path: 'README.md' }] } });
      }
      if (url.includes('/git/trees/dotgithub')) {
        // No walk can repair this one: the directory itself does not fit.
        return makeResponse({ json: { truncated: true, tree: [{ type: 'blob', path: 'SECURITY.md' }] } });
      }
      return makeResponse({
        json: {
          tree: [
            { type: 'blob', path: 'README.md' },
            { type: 'tree', path: '.github', sha: 'dotgithub' },
          ],
        },
      });
    }
    return makeResponse({ text: '# content' });
  };

  await assert.rejects(
    () => fetchRepoFiles('https://github.com/ai-ulu/axiom', { branch: 'main', fetchImpl }),
    (err) => err && err.code === 'GITHUB_TREE_TRUNCATED' && /\.github/.test(err.message),
  );
});

test('github-adapter: a tree entry with no sha fails closed rather than skipping a subtree (#689)', async () => {
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      if (url.includes('recursive=1')) return makeResponse({ json: { truncated: true, tree: [] } });
      return makeResponse({ json: { tree: [{ type: 'tree', path: '.github' }] } });
    }
    return makeResponse({ text: '# content' });
  };

  await assert.rejects(
    () => fetchRepoFiles('https://github.com/ai-ulu/axiom', { branch: 'main', fetchImpl }),
    (err) => err && err.code === 'GITHUB_TREE_INCOMPLETE',
  );
});

test('github-adapter: a partial tree never reaches the mutation path (#689)', async () => {
  let learnEntered = false;
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      // Truncated at every level: unrepairable, so nothing may be ingested.
      return makeResponse({ json: { truncated: true, tree: [{ type: 'blob', path: 'README.md' }] } });
    }
    return makeResponse({ text: '# content' });
  };

  await assert.rejects(
    () => fetchAndLearn('https://github.com/ai-ulu/axiom', {
      async learnAsync() { learnEntered = true; return { data: { learned: 1 } }; },
    }, { branch: 'main', fetchImpl }),
    (err) => err && err.code === 'GITHUB_TREE_TRUNCATED',
  );
  assert.equal(learnEntered, false, 'an incomplete scan must not be ingested as if it were whole');
});

test('github-adapter: an untruncated tree still costs exactly one tree call (#689)', async () => {
  const treeCalls = [];
  const fetchImpl = async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return makeResponse({ json: { sha: TEST_COMMIT_SHA } });
    if (url.includes('/git/trees/')) {
      treeCalls.push(url);
      return makeResponse({
        json: {
          truncated: false,
          tree: [
            { type: 'blob', path: 'README.md' },
            { type: 'blob', path: '.github/SECURITY.md' },
          ],
        },
      });
    }
    return makeResponse({ text: '# content' });
  };

  const files = await fetchRepoFiles('https://github.com/ai-ulu/axiom', { branch: 'main', fetchImpl });

  assert.equal(files.length, 2);
  assert.equal(treeCalls.length, 1);
  assert.match(treeCalls[0], /recursive=1$/);
});
