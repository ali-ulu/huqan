'use strict';

/**
 * #1968. The webhook workflow has never run: it is gated on a
 * `PR_GUARDIAN_WEBHOOK_URL` that does not exist, and a webhook cannot reach a
 * laptop. The repository therefore shipped a governance product it did not
 * apply to itself, behind a permanently skipped check that reads on the pull
 * request page exactly like a passing one.
 *
 * The self-review job closes that without an endpoint. What is pinned here is
 * its security posture, because a gate that a pull request can rewrite is worse
 * than no gate: it reports approval it did not decide.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pr-guardian-self.yml'), 'utf8');
const { summarize } = require('../scripts/pr-guardian-self-review');

test('the policy is read from the base tree, never the pull request', () => {
  // A one-line edit to policy.js in the PR would otherwise let the change
  // approve itself.
  assert.match(WORKFLOW, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
  assert.match(WORKFLOW, /persist-credentials:\s*false/);
});

test('the job holds no more permission than reading the pull request', () => {
  assert.match(WORKFLOW, /^permissions:\n\s+contents: read\n\s+pull-requests: read$/m);
  // Nothing in this job writes: no comment, no label, no status mutation.
  assert.doesNotMatch(WORKFLOW, /issues:\s*write|pull-requests:\s*write|contents:\s*write/);
});

test('the reviewed tree never runs its own lifecycle scripts', () => {
  // `npm ci` on a checkout of the PR's dependencies would execute code the
  // pull request controls, in a job whose whole purpose is to judge it.
  // Only executed lines count -- the comments around the step say "npm ci" too.
  const executed = WORKFLOW
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(executed, /\bnpm (ci|install|run)\b/);
  assert.match(executed, /node scripts\/pr-guardian-self-review\.js/);
});

test('a review is a note and only a block fails the check', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pr-guardian-self-review.js'), 'utf8');
  assert.match(source, /DECISIONS\.BLOCK\)\s*\{[\s\S]{0,200}?return 1;/);
  assert.match(source, /DECISIONS\.REVIEW[\s\S]{0,200}?return 0;/);
});

test('an unreadable snapshot fails closed', () => {
  // An error fetching the diff is not evidence that the diff is safe.
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pr-guardian-self-review.js'), 'utf8');
  assert.match(source, /\.catch\(error =>[\s\S]{0,300}?process\.exitCode = 1;/);
});

test('the summary names the decision, the reason and the labels', () => {
  const text = summarize(
    { decision: 'review', reason: 'ci_workflow_change', riskLabels: ['ci-workflow-change'] },
    { files: [{ filename: '.github/workflows/publish.yml' }], filesTruncated: false, headSha: 'a'.repeat(40) },
  );
  assert.match(text, /\*\*Decision:\*\* `review`/);
  assert.match(text, /`ci_workflow_change`/);
  assert.match(text, /`ci-workflow-change`/);
  assert.match(text, /1 file\(s\)/);
});

test('a truncated snapshot says so', () => {
  // The policy escalates on truncation; the summary has to make the reason
  // visible rather than leaving an unexplained review.
  const text = summarize(
    { decision: 'review', reason: 'file_list_truncated', riskLabels: [] },
    { files: new Array(300).fill({ filename: 'x' }), filesTruncated: true, headSha: 'b'.repeat(40) },
  );
  assert.match(text, /300 file\(s\) \(truncated\)/);
});
