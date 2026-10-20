'use strict';

/**
 * #4123: the nightly `refresh-shard-weights` job must publish its commit
 * through `createCommitOnBranch` (signed server-side) rather than a local
 * `git commit`, which is unsigned and makes the pull request unmergeable
 * against the `required_signatures` rule on `main`.
 *
 * The request body is pinned here because it is the part a reviewer cannot see
 * in a nightly log: a wrong `expectedHeadOid` silently turns the mutation into
 * a refusal, and a wrongly encoded `contents` would commit a corrupt weights
 * file that the next run reads back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { buildCommitInput, parseArgs, publishCommit } = require('../scripts/create-signed-commit');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');

test('the commit input carries the base64 contents and the expected head', () => {
  const input = buildCommitInput({
    repo: 'ali-ulu/huqan',
    branch: 'ci/shard-weights-123',
    baseOid: 'a'.repeat(40),
    file: 'config/shard-weights.json',
    contents: '{ "weights": {} }\n',
    headline: 'chore(ci): refresh shard weights from the latest nightly timings',
  });

  assert.equal(input.branch.repositoryNameWithOwner, 'ali-ulu/huqan');
  assert.equal(input.branch.branchName, 'ci/shard-weights-123');
  assert.equal(input.message.headline, 'chore(ci): refresh shard weights from the latest nightly timings');
  // The base the mutation refuses to move past: a stale value fails closed.
  assert.equal(input.expectedHeadOid, 'a'.repeat(40));

  assert.equal(input.fileChanges.additions.length, 1);
  const addition = input.fileChanges.additions[0];
  assert.equal(addition.path, 'config/shard-weights.json');
  assert.equal(Buffer.from(addition.contents, 'base64').toString('utf8'), '{ "weights": {} }\n');
});

test('the contents are base64, not the raw file text', () => {
  const input = buildCommitInput({
    repo: 'r/r', branch: 'b', baseOid: 'a'.repeat(40), file: 'f.json', contents: 'plain', headline: 'h',
  });
  assert.notEqual(input.fileChanges.additions[0].contents, 'plain');
  assert.match(input.fileChanges.additions[0].contents, /^[A-Za-z0-9+/=]+$/);
});

test('missing positional arguments are a usage error, not a silent no-op', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['branch', 'main']), /usage/);
  assert.throws(() => parseArgs(['branch', 'main', 'config/shard-weights.json']), /usage/);
});

test('the headline is every word after the path', () => {
  const parsed = parseArgs(['branch', 'main', 'config/shard-weights.json', 'chore(ci):', 'refresh', 'weights']);
  assert.equal(parsed.branch, 'branch');
  assert.equal(parsed.base, 'main');
  assert.equal(parsed.file, 'config/shard-weights.json');
  assert.equal(parsed.headline, 'chore(ci): refresh weights');
});

test('the refresh job commits through the signed API, never a local git commit', () => {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
  const job = workflow.jobs['refresh-shard-weights'];
  assert.ok(job, 'refresh-shard-weights job must exist');
  const run = (job.steps || []).map((step) => step.run || '').join('\n');

  assert.match(run, /scripts\/create-signed-commit\.js/);
  // The unsigned path is exactly what made every refresh pull request
  // unmergeable (#4123); it must not come back.
  assert.doesNotMatch(run, /(^|\n)\s*git commit/m);
  assert.doesNotMatch(run, /(^|\n)\s*git push/m);
  // The job still skips the pull request when nothing moved.
  assert.match(run, /changed=true/);
});

test('the refresh job keeps contents:write so the commit and ref can be created', () => {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
  const permissions = workflow.jobs['refresh-shard-weights'].permissions;
  assert.equal(permissions.contents, 'write');
});

// A failed commit attempt must not strand the branch ref it just cut: no pull
// request exists yet, and branch-cleanup.yml only fires on a closed PR. But a
// response can also fail after GitHub created the commit, so the ref may only
// be deleted while it still points at the base.

test('a failed commit deletes the branch ref while it still points at the base', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && /git\/ref\/heads\//.test(args[1] || '')) {
      return JSON.stringify({ object: { sha: 'b'.repeat(40) } });
    }
    if (args.includes('--input')) throw new Error('graphql exploded');
    return '';
  };

  assert.throws(() => publishCommit({
    repo: 'r/r', branch: 'ci/x', baseOid: 'b'.repeat(40),
    file: 'f.json', contents: 'x', headline: 'h', run,
  }), /graphql exploded/);

  assert.ok(calls.some((c) => c.includes('--method DELETE') && c.includes('refs/heads/ci/x')),
    'the unchanged ref should be deleted');
});

test('a failed commit keeps a ref that already moved off the base', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && /git\/ref\/heads\//.test(args[1] || '')) {
      // The ref now carries a commit the attempt did create: not ours to delete.
      return JSON.stringify({ object: { sha: 'c'.repeat(40) } });
    }
    if (args.includes('--input')) throw new Error('response dropped after the commit landed');
    return '';
  };

  assert.throws(() => publishCommit({
    repo: 'r/r', branch: 'ci/x', baseOid: 'b'.repeat(40),
    file: 'f.json', contents: 'x', headline: 'h', run,
  }), /response dropped/);

  assert.ok(!calls.some((c) => c.includes('--method DELETE')),
    'a ref that moved off the base must be preserved');
});
