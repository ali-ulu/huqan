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
 *
 * That claim is read from the dotted `npm view` path `_npmUser.trustedPublisher.id`,
 * not from `_npmUser` (#4056): npm 11 humanizes the whole `_npmUser` object to
 * `"GitHub Actions <npm-oidc-no-reply@github.com>"` when it carries a trusted
 * publisher, so the field this module needs is a string under npm 11 and an
 * object under npm 10. The dotted path reads `"github"` under both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyRegistryVersion,
  parseRegistryView,
  isAlreadyOnRegistry,
  packedShasum,
  settleStagedPublish,
  main,
} = require('../scripts/npm-release-state');

const SHA = 'b07de1f14b6656b4d0bc3f03870fb6e272f836a7';
const fromThisCommit = {
  gitHead: SHA,
  '_npmUser.trustedPublisher.id': 'github',
};

test('a version this commit published through the trusted publisher is recognised', () => {
  assert.equal(classifyRegistryVersion(null, SHA), 'absent');
  assert.equal(classifyRegistryVersion(fromThisCommit, SHA), 'published-from-this-commit');
});

test('a version from another commit or another publisher is never adopted', () => {
  assert.equal(classifyRegistryVersion({ ...fromThisCommit, gitHead: 'f'.repeat(40) }, SHA), 'published-elsewhere');
  assert.equal(classifyRegistryVersion({ gitHead: SHA, '_npmUser.trustedPublisher.id': 'gitlab' }, SHA), 'published-elsewhere');
  assert.equal(classifyRegistryVersion({ gitHead: SHA }, SHA), 'published-elsewhere');
  assert.equal(classifyRegistryVersion({ '_npmUser.trustedPublisher.id': 'github' }, SHA), 'published-elsewhere');
});

test('the registry reply is read the same way under npm 10 and npm 11', () => {
  // npm 10 answers `_npmUser` as an object; the dotted path is a plain string
  // on both, which is the only shape this module classifies on.
  const both = JSON.stringify({ name: 'huqan', version: '1.1.1', gitHead: SHA, '_npmUser.trustedPublisher.id': 'github' });
  assert.equal(classifyRegistryVersion(parseRegistryView(both), SHA), 'published-from-this-commit');

  // A record with a trusted publisher but no gitHead is the one case where npm
  // would collapse the reply to a bare scalar if `name`/`version` were not asked
  // for; it must still parse and still be refused.
  const noGitHead = JSON.stringify({ name: 'huqan', version: '1.1.1', '_npmUser.trustedPublisher.id': 'github' });
  assert.equal(classifyRegistryVersion(parseRegistryView(noGitHead), SHA), 'published-elsewhere');

  // A human publish carries no trusted publisher and must not settle.
  const human = JSON.stringify({ name: 'express', version: '4.19.2', gitHead: SHA });
  assert.equal(classifyRegistryVersion(parseRegistryView(human), SHA), 'published-elsewhere');

  assert.equal(parseRegistryView(''), null, 'empty stdout is an absent version');
  assert.equal(parseRegistryView('npm error code E404'), null, 'npm error text is not a record');
});

test('npm 12\'s array-shaped reply is read from its last entry', () => {
  const record = { name: 'huqan', version: '1.1.1', gitHead: SHA, '_npmUser.trustedPublisher.id': 'github' };
  assert.equal(classifyRegistryVersion(parseRegistryView(JSON.stringify([record])), SHA), 'published-from-this-commit');
});

test('both of the shapes npm uses for a version the registry already holds count as a settle candidate', () => {
  // v1.1.0: the earlier upload was still staged, so npm answered 409.
  assert.equal(isAlreadyOnRegistry('npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/huqan - Cannot publish over previously staged version "1.1.0".'), true);
  // v1.1.1: the earlier upload had already been promoted, so npm answered 403
  // and worded it differently. Same fact, and the run failed the same way.
  assert.equal(isAlreadyOnRegistry('npm error code E403\nnpm error 403 You cannot publish over the previously published versions: 1.1.1.'), true);
  // Every other failure stays a failure.
  assert.equal(isAlreadyOnRegistry('npm error 404 Not Found - PUT https://registry.npmjs.org/huqan'), false);
  assert.equal(isAlreadyOnRegistry('npm error 401 Unauthorized - PUT https://registry.npmjs.org/huqan'), false);
});

test('the shasum of the tarball this run packed is read from the publish log', () => {
  // npm prints it before the upload attempt, so a run that failed still
  // knows what it was about to publish (v1.1.0's failed log carries it).
  const log = 'npm notice shasum: 3c66249e58a8a6e865e3998ae52459fda995861c\nnpm error code E409\n';
  assert.equal(packedShasum(log), '3c66249e58a8a6e865e3998ae52459fda995861c');
  assert.equal(packedShasum('npm error 404 Not Found'), '');
});

test('a version from this commit whose tarball is not the one this run packed is not adopted', () => {
  const shasum = '17afe43aa68a943fbd70985141124f2f72443606';
  const record = { ...fromThisCommit, 'dist.shasum': shasum };
  assert.equal(classifyRegistryVersion(record, SHA, shasum), 'published-from-this-commit');
  assert.equal(classifyRegistryVersion(record, SHA, '3c66249e58a8a6e865e3998ae52459fda995861c'), 'published-different-tarball');
  // With nothing to compare against, the commit and the publisher decide.
  assert.equal(classifyRegistryVersion(record, SHA), 'published-from-this-commit');
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

test('a settle that finds a different tarball does not adopt the version', async () => {
  const shasum = '17afe43aa68a943fbd70985141124f2f72443606';
  const clock = () => { let t = 0; return () => (t += 1_000); };
  const verdict = await settleStagedPublish({
    lookup: async () => ({ ...fromThisCommit, 'dist.shasum': '3c66249e58a8a6e865e3998ae52459fda995861c' }),
    sha: SHA,
    expectedShasum: shasum,
    timeoutMs: 3_000,
    intervalMs: 1_000,
    sleep: async () => {},
    now: clock(),
  });
  assert.equal(verdict, 'published-different-tarball');
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
