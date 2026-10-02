'use strict';

// Every branch of validateGitState with injected evidence. Run only through
// scripts/agent-context.js, which side executes depends on the checkout: a PR
// merge ref, a push to main and a release tag each take a different path, so
// the coverage ratchet measured the CI event rather than the code.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isReleaseCheckout,
  readReleaseTag,
  requireGitEvidence,
  validateGitState,
} = require('../scripts/agent-context-git');

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MAX_AGE = 30 * 60 * 1000;
const CHECKPOINT = Object.freeze({ repository: 'ali-ulu/huqan', baselineBranch: 'main', canonicalMain: 'c0' });

// A linear history c0 <- c1 <- c2; `ahead` sits on c2, `old` is unrelated.
const ORDER = ['c0', 'c1', 'c2', 'ahead'];
function isAncestor(ancestor, descendant) {
  const a = ORDER.indexOf(ancestor);
  const d = ORDER.indexOf(descendant);
  return a >= 0 && d >= 0 && a <= d;
}

function evidence(overrides = {}) {
  return {
    repository: 'ali-ulu/huqan',
    branch: 'main',
    head: 'c2',
    originMain: 'c2',
    releaseTag: '',
    worktree: '',
    baselineSyncedAt: NOW - 60 * 1000,
    ...overrides,
  };
}

function validate(overrides, options = {}) {
  return validateGitState(CHECKPOINT, evidence(overrides), isAncestor, { now: NOW, maxAgeMs: MAX_AGE, ...options });
}

test('a release checkout is detached and at a v* tag, nothing less', () => {
  assert.equal(isReleaseCheckout('', 'v0.13.2'), true);
  assert.equal(isReleaseCheckout('main', 'v0.13.2'), false);
  assert.equal(isReleaseCheckout('', 'nightly'), false);
  assert.equal(isReleaseCheckout('', ''), false);
  assert.equal(isReleaseCheckout('', undefined), false);
});

test('the baseline branch at origin/main is BASELINE; a drifted checkpoint is STALE_ANCESTOR', () => {
  const result = validate({ worktree: ' M file.js' });
  assert.equal(result.headPosition, 'BASELINE');
  assert.equal(result.checkpointDrift, 'STALE_ANCESTOR');
  assert.equal(result.worktree, 'DIRTY_REPORTED');
  assert.equal(result.releaseTag, null);
  assert.equal(result.baselineFreshness, 'FRESH');

  const current = validate({ head: 'c0', originMain: 'c0' });
  assert.equal(current.checkpointDrift, 'CURRENT');
  assert.equal(current.worktree, 'CLEAN');
});

test('work on top of origin/main is AHEAD_OF_BASELINE, detached included', () => {
  const branch = validate({ branch: 'feat/x', head: 'ahead' });
  assert.equal(branch.headPosition, 'AHEAD_OF_BASELINE');
  assert.equal(branch.currentBranch, 'feat/x');
  const detached = validate({ branch: '', head: 'ahead' });
  assert.equal(detached.currentBranch, '(detached)');
});

test('a tagged release behind origin/main is accepted as RELEASE_TAG', () => {
  const result = validate({ branch: '', head: 'c1', releaseTag: 'v0.13.2' });
  assert.equal(result.headPosition, 'RELEASE_TAG');
  assert.equal(result.releaseTag, 'v0.13.2');

  // The tag alone is not enough: a v* tag pushed onto a commit origin/main
  // cannot reach is exactly the hole the ancestry half closes.
  assert.throws(() => validate({ branch: '', head: 'old', releaseTag: 'v9.9.9' }), /feature branch \(detached\) does not descend/);
});

test('every conflict is collected and fails closed with CONTEXT_CONFLICT', () => {
  assert.throws(() => validate({ branch: 'main', head: 'c1' }), /baseline HEAD expected origin\/main c2, observed c1/);
  assert.throws(() => validate({ branch: 'feat/x', head: 'old' }), /feature branch feat\/x does not descend from origin\/main/);
  assert.throws(() => validate({ branch: '', head: 'old' }), /feature branch \(detached\) does not descend/);
  assert.throws(() => validate({ branch: 'main', head: 'c1', releaseTag: 'v0.13.2' }), /baseline HEAD expected/,
    'a named branch carrying a tag is not a release checkout');
  assert.throws(() => validate({ repository: 'someone/fork' }), /repository expected ali-ulu\/huqan, observed someone\/fork/);
  assert.throws(() => validate({ repository: null }), /observed unknown/);
  assert.throws(
    () => validateGitState({ ...CHECKPOINT, canonicalMain: 'old' }, evidence(), isAncestor, { now: NOW, maxAgeMs: MAX_AGE }),
    /checkpoint main old is not an ancestor of origin\/main c2/,
  );

  try {
    validate({ repository: 'someone/fork', branch: 'feat/x', head: 'old' });
    assert.fail('expected a conflict');
  } catch (error) {
    assert.equal(error.code, 'CONTEXT_CONFLICT');
    assert.match(error.message, /repository expected .*; feature branch feat\/x/);
  }
});

test('baseline freshness: stale and unknown conflict, a zero limit opts out', () => {
  assert.throws(() => validate({ baselineSyncedAt: NOW - 2 * MAX_AGE }), /last synced with the remote 60 minutes ago, past the 30 minute limit/);
  assert.throws(() => validate({ baselineSyncedAt: null }), /has no recorded sync with the remote/);
  const unmeasured = validate({ baselineSyncedAt: null }, { maxAgeMs: 0 });
  assert.equal(unmeasured.baselineFreshness, 'UNMEASURED_BY_CONFIG');
  assert.equal(unmeasured.baselineSyncedAt, null);
});

test('git evidence helpers: a missing answer is a conflict, a missing tag is empty', () => {
  assert.throws(
    () => requireGitEvidence('nonexistent ref', ['rev-parse', '--verify', 'refs/heads/no-such-branch-for-this-test']),
    (error) => error.code === 'CONTEXT_CONFLICT' && /nonexistent ref is unavailable/.test(error.message),
  );
  assert.match(requireGitEvidence('HEAD', ['rev-parse', 'HEAD']), /^[0-9a-f]{40}$/);
  const tag = readReleaseTag();
  assert.equal(typeof tag, 'string');
  assert.ok(tag === '' || /^v/.test(tag));
});
