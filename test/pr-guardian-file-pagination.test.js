'use strict';

/**
 * A PR's risk scan has to see the whole diff.
 *
 * The files endpoint was requested once with `per_page=100` and its pagination
 * ignored, so file 101 onward never entered the snapshot. Every risk signal in
 * policy.js comes from `files[].filename` and `files[].patch`, so a secret or a
 * migration sitting past file 100 was invisible -- and reordering the same PR's
 * files could change the decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGitHubRestClient } = require('../lib/pr-guardian/github-client');
const { evaluatePullRequest } = require('../lib/pr-guardian/policy');

function filePage(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `${prefix}-${index}.js`,
    patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
  }));
}

/** A fetch stub serving a paginated pull-request files endpoint. */
function stubFetch(pages) {
  const requested = [];
  return {
    requested,
    impl: async (url) => {
      requested.push(url);
      const parsed = new URL(url);
      let body;
      if (parsed.pathname.endsWith('/files')) {
        body = pages[Number(parsed.searchParams.get('page') || '1') - 1] || [];
      } else if (parsed.pathname.endsWith('/check-runs')) {
        body = { check_runs: [] };
      } else {
        body = { title: 'a change', body: '', number: 1, head: { sha: 'a'.repeat(40), ref: 'feature' }, base: { ref: 'main' }, user: { login: 'ali' }, html_url: 'https://example.invalid/pr/1', labels: [] };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
}

async function snapshotWith(pages) {
  const stub = stubFetch(pages);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub.impl;
  try {
    const client = createGitHubRestClient({ token: 'test-token' });
    const snapshot = await client.getPullRequestSnapshot('acme/app', 1, { workspaceId: 'github:acme/app' });
    return { snapshot, requested: stub.requested };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('files past the first page are fetched', async () => {
  const { snapshot, requested } = await snapshotWith([filePage(100, 'first'), filePage(30, 'second')]);

  assert.equal(snapshot.files.length, 130);
  assert.equal(requested.filter((url) => url.includes('/files')).length, 2);
  assert.equal(snapshot.filesTruncated, false);
});

test('a risky file on the second page reaches the policy', async () => {
  const risky = { filename: 'infra/production-secret.env', patch: '@@ -0,0 +1 @@\n+AWS_SECRET_ACCESS_KEY=abc\n' };
  const { snapshot } = await snapshotWith([filePage(100, 'safe'), [risky]]);

  assert.ok(
    snapshot.files.some((file) => file.filename === risky.filename),
    'the file the scan exists to catch must be in the snapshot',
  );
});

test('one short page needs only one request', async () => {
  const { snapshot, requested } = await snapshotWith([filePage(12, 'only')]);

  assert.equal(snapshot.files.length, 12);
  assert.equal(requested.filter((url) => url.includes('/files')).length, 1);
  assert.equal(snapshot.filesTruncated, false);
});

test('an exhausted page budget is reported, not swallowed', async () => {
  const pages = Array.from({ length: 12 }, (_, index) => filePage(100, `page${index}`));

  const { snapshot, requested } = await snapshotWith(pages);

  assert.equal(requested.filter((url) => url.includes('/files')).length, 10, 'the budget bounds the request count');
  assert.equal(snapshot.filesTruncated, true);
});

test('a truncated file list sends the PR to review', () => {
  const base = {
    repo: 'acme/app',
    number: 1,
    headSha: 'a'.repeat(40),
    workspaceId: 'github:acme/app',
    baseRef: 'main',
    headRef: 'feature',
    title: 'a change',
    body: '',
    files: [{ filename: 'README.md', patch: '' }],
    checks: [{ name: 'CI', status: 'completed', conclusion: 'success', required: true }],
  };

  const complete = evaluatePullRequest(base);
  const truncated = evaluatePullRequest({ ...base, filesTruncated: true });

  assert.equal(complete.decision, 'allow');
  assert.ok(!complete.reasons.includes('file_list_truncated'));
  assert.equal(truncated.decision, 'review', 'an unexamined tail is not evidence of safety');
  assert.ok(truncated.reasons.includes('file_list_truncated'));
});
