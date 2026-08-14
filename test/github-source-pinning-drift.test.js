'use strict';

/**
 * End-to-end falsification for one claim, across the two GitHub ingest paths
 * that #671 left out: whatever route external GitHub content takes, the version
 * that was read is written down immutably.
 *
 * The two paths fail that claim for different reasons, and the difference
 * decides what each fix is:
 *
 *   plugins/repo-memory.js   Fetches through adapters/github-adapter.js, so
 *                            since #671 the bytes are already pinned to a
 *                            resolved commit and every file it receives carries
 *                            commitSha. It records none of it. The pin exists at
 *                            fetch time and is discarded before storage.
 *
 *   lib/github-connector.js  Fetches nothing at all -- it normalises an item it
 *                            was handed. Its references name mutable things:
 *                            a PR whose commits move, an issue whose body is
 *                            editable, a tag that can be repointed. Only its
 *                            commit_message subtype is immutable, and even there
 *                            the sha never reaches provenance.
 *
 * So neither fix is "resolve a SHA and fetch by it" a second time. One is
 * "record what you already hold", the other is "let the caller state the version
 * and record that". Both are asserted here as drift: two ingests that a reader
 * must be able to tell apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const createRepoMemoryPlugin = require('../plugins/repo-memory').create;
const { buildGitHubProvenance } = require('../lib/github-connector');
const { contentHash } = require('../lib/content-hash');

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

function makeKernel(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-pin-${label}-`));
  tempDirs.push(dir);
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
    capabilities: { companyMode: true, pluginCapabilities: true },
  });
  kernel.usePlugin(createRepoMemoryPlugin());
  return kernel;
}

/** A repo whose branch moves between ingests, addressed by commit-ish. */
function movingRepo() {
  const state = { head: COMMIT_A };
  const byCommit = {
    [COMMIT_A]: '# Runbook\n\nStep one, as originally written.\n',
    [COMMIT_B]: '# Runbook\n\nStep one, quietly rewritten.\n',
  };

  const response = ({ ok = true, status = 200, json = null, text = '' }) => ({
    ok,
    status,
    json: async () => json,
    text: async () => text,
    headers: { get: () => '' },
  });

  const fetchImpl = async (url) => {
    const commitMatch = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/([^/?]+)$/);
    if (commitMatch) {
      const ref = decodeURIComponent(commitMatch[1]);
      const sha = ref === 'main' ? state.head : ref;
      if (!byCommit[sha]) return response({ ok: false, status: 404, json: {} });
      return response({ json: { sha } });
    }
    if (url.includes('/git/trees/')) {
      return response({ json: { tree: [{ type: 'blob', path: 'RUNBOOK.md' }] } });
    }
    const rawMatch = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
    if (rawMatch) {
      const ref = decodeURIComponent(rawMatch[1]);
      const sha = ref === 'main' ? state.head : ref;
      const body = byCommit[sha];
      if (body === undefined) return response({ ok: false, status: 404, text: '' });
      return response({ text: body });
    }
    return response({ ok: false, status: 404, text: '' });
  };

  return { fetchImpl, contentAt: (sha) => byCommit[sha], moveBranchTo: (sha) => { state.head = sha; } };
}

/** Everything the kernel ended up holding, as one string. */
function everythingStored(kernel) {
  const raw = typeof kernel.graph.getNodes === 'function' ? kernel.graph.getNodes('default') : null;
  const parts = [JSON.stringify(raw)];
  const ids = new Set(Object.keys(raw || {}));
  for (const id of ids) {
    parts.push(JSON.stringify(kernel.graph.getEdges(id, 'default') || []));
    if (typeof kernel.graph.getInEdges === 'function') {
      parts.push(JSON.stringify(kernel.graph.getInEdges(id, 'default') || []));
    }
  }
  const serialised = parts.join('\n');
  assert.ok(ids.size > 0,
    'everythingStored found no graph content; the assertions using it prove nothing');
  return serialised;
}

async function ingestRepo(kernel, repo) {
  return kernel.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'github',
    repoUrl: 'https://github.com/ai-ulu/axiom',
    fetchImpl: repo.fetchImpl,
  });
}

// ---------------------------------------------------------------------------

test.describe('repo-memory records the commit it was already given', () => {
  test('the commit reaches storage', async () => {
    const kernel = makeKernel('repo-commit');
    const repo = movingRepo();
    const result = await ingestRepo(kernel, repo);

    assert.equal(result.ok, true);
    const stored = everythingStored(kernel);
    assert.ok(stored.includes(COMMIT_A),
      'repo-memory fetched at a pinned commit and stored nothing that names it');
  });

  test('the content hash reaches storage', async () => {
    const kernel = makeKernel('repo-hash');
    const repo = movingRepo();
    await ingestRepo(kernel, repo);

    const stored = everythingStored(kernel);
    assert.ok(stored.includes(contentHash(repo.contentAt(COMMIT_A))),
      'no hash of what was read was stored, so drift cannot be detected from the record');
  });

  test('two ingests across a moving branch are distinguishable', async () => {
    // The drift case. Same repo, same path, same capability call -- a reader
    // holding both records must be able to tell that the source moved.
    const repo = movingRepo();

    const before = makeKernel('repo-before');
    await ingestRepo(before, repo);
    const storedBefore = everythingStored(before);

    repo.moveBranchTo(COMMIT_B);

    const after = makeKernel('repo-after');
    await ingestRepo(after, repo);
    const storedAfter = everythingStored(after);

    assert.ok(storedBefore.includes(COMMIT_A) && !storedBefore.includes(COMMIT_B));
    assert.ok(storedAfter.includes(COMMIT_B) && !storedAfter.includes(COMMIT_A));
    assert.ok(storedBefore.includes(contentHash(repo.contentAt(COMMIT_A))));
    assert.ok(storedAfter.includes(contentHash(repo.contentAt(COMMIT_B))));
    assert.notEqual(
      contentHash(repo.contentAt(COMMIT_A)),
      contentHash(repo.contentAt(COMMIT_B)),
      'the fixture did not actually change; this case proves nothing',
    );
  });
});

// ---------------------------------------------------------------------------

test.describe('github-connector records the version of the item it was handed', () => {
  test('a commit item records its sha', () => {
    const { provenance } = buildGitHubProvenance({
      repo: 'ai-ulu/axiom',
      sourceSubType: 'commit_message',
      sha: COMMIT_A,
      title: 'Fix the thing',
      body: 'A commit message body.',
    });

    assert.equal(provenance.sourceVersion, COMMIT_A,
      'the connector had the sha in hand and did not record it');
    assert.equal(provenance.sourceVersionKind, 'commit_sha');
  });

  test('a pull request records the head sha the caller supplied', () => {
    // A PR reference is mutable: the branch behind it gains commits and the body
    // is editable. The head sha is the only thing that names a version of it.
    const { provenance } = buildGitHubProvenance({
      repo: 'ai-ulu/axiom',
      sourceSubType: 'merged_pr',
      number: 671,
      headSha: COMMIT_A,
      title: 'Pin the source version',
      body: 'PR body as reviewed.',
    });

    assert.equal(provenance.sourceVersion, COMMIT_A);
    assert.equal(provenance.sourceVersionKind, 'pr_head_sha');
  });

  test('the claim text is hashed, so an edited body is visible', () => {
    // The drift case for this path. Same PR number, same sourceRef, edited body.
    const base = {
      repo: 'ai-ulu/axiom', sourceSubType: 'merged_pr', number: 671, headSha: COMMIT_A,
      title: 'Pin the source version',
    };
    const first = buildGitHubProvenance({ ...base, body: 'PR body as reviewed.' }).provenance;
    const edited = buildGitHubProvenance({ ...base, body: 'PR body, quietly rewritten.' }).provenance;

    assert.equal(first.sourceRef, edited.sourceRef,
      'the premise has changed: sourceRef already distinguishes these');
    assert.ok(first.contentHash, 'no content hash was recorded for the claim');
    assert.notEqual(first.contentHash, edited.contentHash,
      'an edited PR body produced the same record; drift is not detectable');
  });

  test('an item with no version identifier records none, rather than an empty one', () => {
    // An issue the caller could not pin must not produce a record that reads as
    // pinned. Absent is the honest value, and the content hash still applies.
    const { provenance } = buildGitHubProvenance({
      repo: 'ai-ulu/axiom',
      sourceSubType: 'open_issue',
      number: 42,
      title: 'Something',
      body: 'An issue body.',
    });

    assert.ok(!provenance.sourceVersion,
      `expected no sourceVersion, got ${JSON.stringify(provenance.sourceVersion)}`);
    assert.ok(provenance.contentHash,
      'with no version identifier the content hash is the only signal, and it is missing');
  });
});
