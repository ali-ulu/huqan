'use strict';

/**
 * v1.1.0's publish uploaded the tarball, then npm answered `409 Cannot publish
 * over previously staged version "1.1.0"` and the run failed -- while the
 * registry promoted that very upload five minutes later. The release was real
 * and the workflow called it a failure, so release-verify never ran and
 * Release Distribution never created the GitHub Release. Re-running the tag
 * could not recover either: the republish guard refused the version this same
 * commit had just published.
 *
 * Both decisions now go through scripts/npm-release-state.js, which only ever
 * accepts a registry version that this commit published through the GitHub
 * trusted publisher.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyRegistryVersion,
  isStagedConflict,
  settleStagedPublish,
  main,
} = require('../scripts/npm-release-state');

const SHA = 'b07de1f14b6656b4d0bc3f03870fb6e272f836a7';
const fromThisCommit = {
  gitHead: SHA,
  _npmUser: { name: 'GitHub Actions', trustedPublisher: { id: 'github' } },
};

test('a version this commit published through the trusted publisher is recognised', () => {
  assert.equal(classifyRegistryVersion(null, SHA), 'absent');
  assert.equal(classifyRegistryVersion(fromThisCommit, SHA), 'published-from-this-commit');
});

test('a version from another commit or another publisher is never adopted', () => {
  assert.equal(classifyRegistryVersion({ ...fromThisCommit, gitHead: 'f'.repeat(40) }, SHA), 'published-elsewhere');
  assert.equal(classifyRegistryVersion({ gitHead: SHA, _npmUser: { name: 'aliulu' } }, SHA), 'published-elsewhere');
  assert.equal(classifyRegistryVersion({ _npmUser: fromThisCommit._npmUser }, SHA), 'published-elsewhere');
});

test('only the staged-version conflict counts as a settle candidate', () => {
  assert.equal(isStagedConflict('npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/huqan - Cannot publish over previously staged version "1.1.0".'), true);
  assert.equal(isStagedConflict('npm error 404 Not Found - PUT https://registry.npmjs.org/huqan'), false);
  assert.equal(isStagedConflict('npm error 403 You cannot publish over the previously published versions: 1.1.0.'), false);
});

test('a staged upload settles once the registry serves it from this commit', async () => {
  const answers = [null, null, fromThisCommit];
  const sleeps = [];
  const verdict = await settleStagedPublish({
    lookup: async () => answers.shift(),
    sha: SHA,
    timeoutMs: 10_000,
    intervalMs: 1_000,
    sleep: async (ms) => { sleeps.push(ms); },
    now: (() => { let t = 0; return () => (t += 1_000); })(),
  });
  assert.equal(verdict, 'published-from-this-commit');
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('a staged upload that never appears, or appears from elsewhere, does not settle', async () => {
  const clock = () => { let t = 0; return () => (t += 1_000); };
  assert.equal(await settleStagedPublish({
    lookup: async () => null, sha: SHA, timeoutMs: 3_000, intervalMs: 1_000, sleep: async () => {}, now: clock(),
  }), 'absent');
  assert.equal(await settleStagedPublish({
    lookup: async () => ({ ...fromThisCommit, gitHead: 'f'.repeat(40) }), sha: SHA, timeoutMs: 3_000, intervalMs: 1_000, sleep: async () => {}, now: clock(),
  }), 'published-elsewhere');
});

test('settle refuses any other publish failure without waiting on the registry', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'npm-release-state-'));
  try {
    const log = path.join(dir, 'npm-publish.log');
    fs.writeFileSync(log, 'npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/huqan\n');
    let stderr = '';
    const code = await main(['node', 'npm-release-state.js', 'settle', 'huqan', '9.9.9', SHA, log],
      { NPM_SETTLE_TIMEOUT_MS: '1', NPM_SETTLE_INTERVAL_MS: '1' }, () => {}, (text) => { stderr += text; });
    assert.equal(code, 1);
    assert.doesNotMatch(stderr, /waiting for the registry/, 'a non-staging failure must not be waited out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish.yml routes the republish guard and a failed upload through the registry state', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  const guard = workflow.slice(workflow.indexOf('- name: Refuse to republish an existing version'), workflow.indexOf('- name: Require a signed release tag'));
  assert.match(guard, /id: registry/);
  assert.match(guard, /node scripts\/npm-release-state\.js existing/);
  assert.match(guard, /already_published=true/);

  const publish = workflow.slice(workflow.indexOf('      - name: Publish\n'), workflow.indexOf('- name: Verify the complete release checklist'));
  assert.match(publish, /steps\.registry\.outputs\.already_published != 'true'/);
  assert.match(publish, /node scripts\/npm-release-state\.js settle/);
  // The settle path is the only way a failed upload can still pass; anything
  // else keeps the explanation and the failing exit status.
  assert.ok(publish.indexOf('npm-release-state.js settle') < publish.indexOf('explain-npm-publish-failure.js'));
});
