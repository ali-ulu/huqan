'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { commitVerification, unsignedCommits, formatFailures, main } = require('../scripts/check-pr-signatures');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'workflow-governance.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

/** One entry in GitHub's raw /pulls/{n}/commits shape. */
function rawCommit(sha, { verified, reason, name = 'aliulu', headline = 'change' } = {}) {
  return {
    sha,
    commit: {
      author: { name },
      message: `${headline}\n\nbody\n`,
      verification: { verified, reason },
    },
  };
}

test('a commit GitHub reports as verified passes', () => {
  const commits = [rawCommit('a'.repeat(40), { verified: true, reason: 'valid' })];
  assert.deepEqual(unsignedCommits(commits), []);
});

test('an unsigned commit is reported with its sha, reason and author', () => {
  const commits = [rawCommit('d463529b4'.padEnd(40, '0'), {
    verified: false, reason: 'unsigned', name: 'openhands', headline: 'fix(http): enforce the declared stop',
  })];
  const unsigned = unsignedCommits(commits);
  assert.equal(unsigned.length, 1);
  assert.equal(unsigned[0].reason, 'unsigned');
  assert.equal(unsigned[0].author, 'openhands');
  assert.match(unsigned[0].headline, /enforce the declared stop/);
});

test('a mixed commit list reports only the unsigned commits', () => {
  const commits = [
    rawCommit('1'.repeat(40), { verified: true, reason: 'valid' }),
    rawCommit('2'.repeat(40), { verified: false, reason: 'unsigned' }),
    rawCommit('3'.repeat(40), { verified: true, reason: 'valid' }),
  ];
  assert.deepEqual(unsignedCommits(commits).map((commit) => commit.sha), ['2'.repeat(40)]);
});

test('the flattened gh --jq shape is accepted too', () => {
  const commits = [
    { sha: 'a'.repeat(40), verified: true, reason: 'valid', author: 'aliulu', message: 'signed' },
    { sha: 'b'.repeat(40), verified: false, reason: 'unsigned', author: 'openhands', message: 'not signed' },
  ];
  const unsigned = unsignedCommits(commits);
  assert.deepEqual(unsigned.map((commit) => commit.sha), ['b'.repeat(40)]);
  assert.equal(unsigned[0].author, 'openhands');
});

test('the paginated gh --slurp shape (an array of pages) is flattened', () => {
  const pages = [
    [rawCommit('a'.repeat(40), { verified: true, reason: 'valid' })],
    [rawCommit('b'.repeat(40), { verified: false, reason: 'unsigned' })],
  ];
  assert.deepEqual(unsignedCommits(pages).map((commit) => commit.sha), ['b'.repeat(40)]);
});

test('a missing verification block counts as unsigned, never as a pass', () => {
  assert.equal(unsignedCommits([{ sha: 'c'.repeat(40) }]).length, 1);
});

test('a non-array payload is refused rather than read as "no unsigned commits"', () => {
  assert.throws(() => unsignedCommits({ commits: [] }), /must be an array/);
});

test('the failure message names the rule and every offending commit', () => {
  const message = formatFailures(unsignedCommits([
    rawCommit('9a3bffe63'.padEnd(40, '0'), { verified: false, reason: 'unsigned', name: 'aliulu' }),
    rawCommit('528599c25'.padEnd(40, '0'), { verified: false, reason: 'unsigned', name: 'openhands' }),
  ]));
  assert.match(message, /requires verified signatures/i);
  assert.match(message, /9a3bffe63/);
  assert.match(message, /528599c25/);
});

test('the CLI exits 0 for a signed list and 1 for an unsigned one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-signatures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signed = path.join(dir, 'signed.json');
  const unsigned = path.join(dir, 'unsigned.json');
  fs.writeFileSync(signed, JSON.stringify([rawCommit('a'.repeat(40), { verified: true, reason: 'valid' })]));
  fs.writeFileSync(unsigned, JSON.stringify([rawCommit('b'.repeat(40), { verified: false, reason: 'unsigned' })]));

  const errors = [];
  t.mock.method(process.stderr, 'write', (chunk) => { errors.push(String(chunk)); return true; });
  assert.equal(main([signed]), 0);
  assert.equal(main([unsigned]), 1);
  assert.equal(main([]), 2);
  t.mock.restoreAll();
  assert.match(errors.join(''), /verified signatures/i);
});

// The workflow contract: the check runs on every pull request, and it is a
// stable required context, so the job name must not drift from the ruleset.
test('workflow-governance.yml runs the signature check on every pull request', () => {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const on = workflow.on ?? workflow[true];
  assert.ok('pull_request' in on, 'the signature check must run on every pull request, unfiltered');
  assert.equal(on.pull_request, null, 'a branch filter would let a stacked PR skip the check');

  const job = workflow.jobs.governance;
  assert.equal(job.name, 'Workflow governance', 'the required context name is pinned by the ruleset');
  const steps = (job.steps || []).map((step) => step.run || '').join('\n');
  assert.match(steps, /scripts\/check-pr-signatures\.js/);
  // The job's own token must be able to read the pull request's commit list.
  assert.equal(job.permissions?.pull_requests ?? job.permissions?.['pull-requests'], 'read');
});

test('package.json exposes the check as a check:* script with an execution path', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.ok(pkg.scripts['check:pr-signatures'], 'check:pr-signatures must be declared');
  assert.match(pkg.scripts['check:pr-signatures'], /scripts\/check-pr-signatures\.js/);
});

// GitHub caps `/pulls/{n}/commits` at 250 commits even with --paginate. A
// truncated list that is read as complete would report success while the
// signature rule still blocks the merge, so the count gap has to fail closed.
test('a commit list shorter than the pull request fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-short-'));
  const file = path.join(dir, 'commits.json');
  fs.writeFileSync(file, JSON.stringify([rawCommit('a'.repeat(40), { verified: true, reason: 'valid' })]), { flag: 'wx' });
  const errors = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try {
    assert.equal(main([file, '2']), 1, 'two commits reported but one retrieved must fail');
    assert.match(errors.join(''), /only 1 were retrieved/);
    assert.equal(main([file, '1']), 0, 'a matching count still passes');
    assert.equal(main([file, '0']), 0, 'no expected count means no completeness claim');
  } finally {
    process.stderr.write = original;
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
