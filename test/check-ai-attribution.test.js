'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  AGENT_IDENTITY, ALLOWED_BOTS, attributionFindings, coAuthors, commitIdentity, formatFailures, isAgent, main,
} = require('../scripts/check-ai-attribution');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'workflow-governance.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

/** One entry in GitHub's raw /pulls/{n}/commits shape. */
function rawCommit(sha, {
  author = { name: 'aliulu', email: 'aliulu@ai-ulu.com' },
  committer = { name: 'aliulu', email: 'aliulu@ai-ulu.com' },
  message = 'change\n\nbody\n',
} = {}) {
  return { sha, commit: { author, committer, message } };
}

test('an owner-authored commit passes', () => {
  assert.deepEqual(attributionFindings([rawCommit('a'.repeat(40))]), []);
});

test('a github-actions[bot] committer passes: it is infrastructure, not an agent author', () => {
  const commits = [rawCommit('a'.repeat(40), {
    author: { name: 'Ali Ulu', email: 'aliulu@ai-ulu.com' },
    committer: { name: 'GitHub', email: 'noreply@github.com' },
  })];
  assert.deepEqual(attributionFindings(commits), []);
});

// The exact shape PR #4157 merged with: all three commits authored and
// committed by Claude. This is the regression this check exists for.
test('the #4157 payload is reported: author and committer both carry the agent name', () => {
  const commits = ['cbea58f7', '6b50b712', '2d3cd9b0'].map((sha) => rawCommit(sha.padEnd(40, '0'), {
    author: { name: 'Claude', email: 'noreply@anthropic.com' },
    committer: { name: 'Claude', email: 'noreply@anthropic.com' },
    message: 'feat(cognition): prediction-error signal and graph pairs reader (#4061)\n',
  }));
  const findings = attributionFindings(commits);
  assert.equal(findings.length, 6, 'three commits x author + committer');
  assert.deepEqual([...new Set(findings.map((f) => f.field))], ['author', 'committer']);
  assert.match(findings[0].value, /noreply@anthropic\.com/);
});

test('the openhands trailer the squash merge carried into main is caught', () => {
  const commits = [rawCommit('1'.repeat(40), {
    message: 'feat(authority): install the POSIX approval authority on Linux (#4082 PR-4) (#4145)\n\nCo-authored-by: openhands <openhands@all-hands.dev>\n',
  })];
  const findings = attributionFindings(commits);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, 'co-author');
  assert.match(findings[0].value, /openhands@all-hands\.dev/);
});

test('a bare agent author name with no email is still caught', () => {
  const commits = [rawCommit('a'.repeat(40), { author: { name: 'openhands', email: '' } })];
  assert.deepEqual(attributionFindings(commits).map((f) => f.field), ['author']);
});

test('an ordinary co-author trailer is not an agent and passes', () => {
  const commits = [rawCommit('a'.repeat(40), {
    message: 'fix: join two paths\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n',
  })];
  assert.deepEqual(attributionFindings(commits), []);
});

test('coAuthors reads every spelling of a co-author trailer', () => {
  const message = [
    'change',
    '',
    'Co-authored-by: Claude <noreply@anthropic.com>',
    'Generated-By: Codex <noreply@openai.com>',
    'Assisted-By: GitHub Copilot <copilot@github.com>',
  ].join('\n');
  assert.deepEqual(coAuthors(message), [
    'Claude <noreply@anthropic.com>',
    'Codex <noreply@openai.com>',
    'GitHub Copilot <copilot@github.com>',
  ]);
});

test('the identity matcher catches each banned token and clears a human name', () => {
  for (const name of ['openhands', 'Claude', 'Codex', 'GitHub Copilot', 'Codebuff', 'Cursor', 'Devin']) {
    assert.equal(isAgent(name, ''), true, `${name} must be treated as an agent identity`);
  }
  assert.equal(isAgent('aliulu', 'aliulu@ai-ulu.com'), false);
  assert.equal(isAgent('Ali Ulu', 'aliulu@ai-ulu.com'), false);
  // A human may legitimately have "agent" in a name; only the banned tokens trip.
  assert.equal(AGENT_IDENTITY.test('Agent Smith'), false);
});

test('the allowlist is scoped to infrastructure bots, not to a name that merely matches', () => {
  assert.equal(ALLOWED_BOTS.test('github-actions[bot]'), true);
  assert.equal(ALLOWED_BOTS.test('dependabot[bot]'), true);
  assert.equal(ALLOWED_BOTS.test('Claude'), false);
  assert.equal(isAgent('github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'), false);
});

test('the flattened gh --jq shape is accepted too', () => {
  const commits = [
    { sha: 'a'.repeat(40), author: { name: 'aliulu', email: 'aliulu@ai-ulu.com' }, committer: { name: 'aliulu' }, message: 'ok' },
    { sha: 'b'.repeat(40), author: { name: 'Claude', email: 'noreply@anthropic.com' }, committer: { name: 'Claude' }, message: 'no' },
  ];
  assert.deepEqual(attributionFindings(commits).map((f) => f.sha), ['b'.repeat(40), 'b'.repeat(40)]);
});

test('the paginated gh --slurp shape (an array of pages) is flattened', () => {
  const pages = [
    [rawCommit('a'.repeat(40))],
    [rawCommit('b'.repeat(40), { author: { name: 'Claude', email: 'noreply@anthropic.com' } })],
  ];
  assert.deepEqual(attributionFindings(pages).map((f) => f.sha), ['b'.repeat(40)]);
});

test('a non-array payload is refused rather than read as "no attribution found"', () => {
  assert.throws(() => attributionFindings({ commits: [] }), /must be an array/);
});

test('commitIdentity defaults missing fields instead of throwing', () => {
  assert.deepEqual(commitIdentity({ sha: 'x' }), {
    sha: 'x', authorName: 'unknown', authorEmail: '', committerName: 'unknown', committerEmail: '', message: '',
  });
});

test('the failure message names the rule, every offending commit and the fix', () => {
  const message = formatFailures(attributionFindings([
    rawCommit('9a3bffe63'.padEnd(40, '0'), { author: { name: 'Claude', email: 'noreply@anthropic.com' } }),
    rawCommit('528599c25'.padEnd(40, '0'), { message: 'x\n\nCo-authored-by: openhands <openhands@all-hands.dev>\n' }),
  ]));
  assert.match(message, /section 10/i);
  assert.match(message, /9a3bffe63/);
  assert.match(message, /528599c25/);
  assert.match(message, /create-signed-commit\.js/);
});

test('the CLI exits 0 for a clean list, 1 for an attributed one, 2 with no argument', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-attribution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clean = path.join(dir, 'clean.json');
  const dirty = path.join(dir, 'dirty.json');
  fs.writeFileSync(clean, JSON.stringify([rawCommit('a'.repeat(40))]));
  fs.writeFileSync(dirty, JSON.stringify([rawCommit('b'.repeat(40), { author: { name: 'Claude', email: 'noreply@anthropic.com' } })]));

  const errors = [];
  t.mock.method(process.stderr, 'write', (chunk) => { errors.push(String(chunk)); return true; });
  assert.equal(main([clean]), 0);
  assert.equal(main([dirty]), 1);
  assert.equal(main([]), 2);
  t.mock.restoreAll();
  assert.match(errors.join(''), /section 10/i);
});

test('an unreadable payload fails closed instead of passing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-attribution-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  const errors = [];
  t.mock.method(process.stderr, 'write', (chunk) => { errors.push(String(chunk)); return true; });
  assert.equal(main([broken]), 1);
  t.mock.restoreAll();
  assert.match(errors.join(''), /could not read/);
});

// The workflow contract: the check runs on every pull request, and the job name
// is a stable required context, so it must not drift from the ruleset.
test('workflow-governance.yml runs the attribution check on every pull request', () => {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const on = workflow.on ?? workflow[true];
  assert.ok('pull_request' in on, 'the attribution check must run on every pull request, unfiltered');
  const pullRequest = on.pull_request ?? {};
  assert.equal(pullRequest.branches, undefined, 'a branch filter would let a stacked PR skip the check');
  assert.equal(pullRequest.paths, undefined, 'a path filter would let an unrelated PR skip the check');

  const job = workflow.jobs.governance;
  assert.equal(job.name, 'Workflow governance', 'the required context name is pinned by the ruleset');
  const steps = (job.steps || []).map((step) => step.run || '').join('\n');
  assert.match(steps, /scripts\/check-ai-attribution\.js/);
  assert.equal(job.permissions?.pull_requests ?? job.permissions?.['pull-requests'], 'read');
});

test('package.json exposes the check as a check:* script with an execution path', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.ok(pkg.scripts['check:ai-attribution'], 'check:ai-attribution must be declared');
  assert.match(pkg.scripts['check:ai-attribution'], /scripts\/check-ai-attribution\.js/);
});
