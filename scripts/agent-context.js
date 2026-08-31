'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const canonPath = path.join(repoRoot, 'docs', 'agent-canon.md');
const deliveryProtocolPath = path.join(repoRoot, 'docs', 'fikirden-urune-protocol.md');
const checkpointPath = path.join(repoRoot, 'docs', 'current-agent-checkpoint.json');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function runGit(args, options = {}) {
  return childProcess.execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trim();
}

function normalizeGitHubRepository(remoteUrl) {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match ? match[1] : null;
}

function contextConflict(message) {
  const error = new Error(`CONTEXT_CONFLICT: ${message}`);
  error.code = 'CONTEXT_CONFLICT';
  return error;
}

/**
 * How old the local `origin/main` may be before this guard stops trusting it.
 *
 * The ancestry check below reads `origin/main`, which is a local ref that only
 * moves when something fetches. Over a long session it goes quietly out of date
 * and the check keeps passing -- against a baseline that is no longer the one
 * CI will measure. Same head, green locally, red in CI (#682). Nothing about
 * the ancestry answer is wrong; it is answered about the wrong `main`.
 *
 * So the age of the reference is measured too, and a reference too old to
 * stand for the remote is a conflict rather than a pass. Thirty minutes is
 * chosen to be shorter than the sessions where this actually bites; the remedy
 * is one fetch.
 */
const DEFAULT_BASELINE_MAX_AGE_MINUTES = 30;
const BASELINE_REFRESH_COMMAND = 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main';

/**
 * Air-gapped work is legitimate, and this guard needs no network -- it reads
 * mtimes. What it cannot do offline is tell a fresh baseline from an old one,
 * so `HUQAN_BASELINE_MAX_AGE_MINUTES=0` turns the measurement off explicitly.
 * That is not the same as passing: the capsule then reports
 * `UNMEASURED_BY_CONFIG`, so "I did not measure this" stays readable in the
 * output instead of looking like "I measured it and it was fine".
 */
function resolveBaselineMaxAgeMs(env = process.env) {
  const raw = env.HUQAN_BASELINE_MAX_AGE_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_BASELINE_MAX_AGE_MINUTES * 60000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw contextConflict(
      `HUQAN_BASELINE_MAX_AGE_MINUTES must be a non-negative number of minutes, observed ${JSON.stringify(raw)}`,
    );
  }
  return minutes * 60000;
}

/**
 * Files git touches when it syncs the baseline with the remote.
 *
 * `FETCH_HEAD` is rewritten by every fetch, including one that finds nothing
 * new -- which is the case that matters, since a repository whose `main` has
 * not moved is still being checked. The loose ref covers the opposite case, a
 * fetch that did move the ref. `packed-refs` is deliberately not consulted:
 * `git gc` rewrites it without contacting anything, so it would report a sync
 * that never happened.
 */
function baselineSyncPaths() {
  const dirs = new Set();
  for (const arg of ['--git-dir', '--git-common-dir']) {
    try {
      dirs.add(path.resolve(repoRoot, runGit(['rev-parse', arg])));
    } catch {
      // A missing common dir just means there is one fewer place to look.
    }
  }

  const candidates = [];
  for (const dir of dirs) {
    candidates.push(path.join(dir, 'FETCH_HEAD'));
    candidates.push(path.join(dir, 'refs', 'remotes', 'origin', 'main'));
  }
  return candidates;
}

function readBaselineSyncedAt(candidates = baselineSyncPaths()) {
  let newest = null;
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

function assessBaselineFreshness(baselineSyncedAt, { now, maxAgeMs }) {
  if (maxAgeMs === 0) {
    return { verdict: 'UNMEASURED_BY_CONFIG', syncedAt: null, ageMinutes: null };
  }
  if (typeof baselineSyncedAt !== 'number' || !Number.isFinite(baselineSyncedAt)) {
    return { verdict: 'UNKNOWN', syncedAt: null, ageMinutes: null };
  }
  const ageMs = now - baselineSyncedAt;
  return {
    verdict: ageMs > maxAgeMs ? 'STALE' : 'FRESH',
    syncedAt: new Date(baselineSyncedAt).toISOString(),
    ageMinutes: Math.max(0, Math.round(ageMs / 60000)),
  };
}

/**
 * Whether HEAD is a release checkout: detached, at a `v*` tag.
 *
 * Detachment is required rather than incidental. A named branch that happens
 * to carry a release tag is still a working branch, and the thing the ancestry
 * check exists to catch -- work built on a baseline that has moved -- looks
 * exactly like that. `publish.yml` checks out the tag itself, so the release
 * path is always detached and nothing is given up by insisting on it.
 */
function isReleaseCheckout(branch, releaseTag) {
  return !branch && /^v/.test(releaseTag || '');
}

/**
 * The `v*` tag at HEAD, or '' when there is none.
 *
 * `--points-at` answers about the commit rather than about how it was reached,
 * so this is the same answer for `git checkout v0.11.0` and for a detached
 * checkout of the SHA the tag names -- the release tree either is the tagged
 * commit or it is not. Tags are sorted for determinism: the capsule is
 * asserted to be byte-identical across calls, and a commit can carry more than
 * one tag.
 */
function readReleaseTag() {
  let output;
  try {
    output = runGit(['tag', '--points-at', 'HEAD'], { allowFailure: true });
  } catch {
    // No tag objects present (a shallow or tagless fetch) is not a conflict on
    // its own; it just means this is not identifiable as a release checkout.
    return '';
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^v/.test(line))
    .sort()[0] || '';
}

function requireGitEvidence(label, args) {
  try {
    return runGit(args);
  } catch {
    throw contextConflict(`${label} is unavailable`);
  }
}

function validateGitState(checkpoint, evidence, isAncestor, options = {}) {
  const {
    repository,
    branch,
    head,
    originMain,
    releaseTag,
    worktree,
    baselineSyncedAt,
  } = evidence;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : resolveBaselineMaxAgeMs();
  const conflicts = [];
  let checkpointDrift = 'CURRENT';
  let headPosition = 'AHEAD_OF_BASELINE';

  const baseline = assessBaselineFreshness(baselineSyncedAt, { now, maxAgeMs });
  if (baseline.verdict === 'STALE') {
    conflicts.push(
      `origin/main was last synced with the remote ${baseline.ageMinutes} minutes ago, past the `
      + `${Math.round(maxAgeMs / 60000)} minute limit, so the ancestry below would be measured against a `
      + `baseline CI does not share; run \`${BASELINE_REFRESH_COMMAND}\` and re-run`,
    );
  }
  if (baseline.verdict === 'UNKNOWN') {
    conflicts.push(
      `origin/main has no recorded sync with the remote, so its age cannot be measured; `
      + `run \`${BASELINE_REFRESH_COMMAND}\` and re-run`,
    );
  }

  if (repository !== checkpoint.repository) {
    conflicts.push(`repository expected ${checkpoint.repository}, observed ${repository || 'unknown'}`);
  }
  if (isAncestor(checkpoint.canonicalMain, originMain)) {
    if (originMain !== checkpoint.canonicalMain) {
      checkpointDrift = 'STALE_ANCESTOR';
    }
  } else {
    conflicts.push(
      `checkpoint main ${checkpoint.canonicalMain} is not an ancestor of origin/main ${originMain}`,
    );
  }
  if (branch === checkpoint.baselineBranch) {
    headPosition = 'BASELINE';
    if (head !== originMain) {
      conflicts.push(`baseline HEAD expected origin/main ${originMain}, observed ${head}`);
    }
  } else if (isAncestor(originMain, head)) {
    // Work in progress on top of the current baseline: the ordinary state.
  } else if (isReleaseCheckout(branch, releaseTag) && isAncestor(head, originMain)) {
    /**
     * A release checkout, which is behind the baseline by design.
     *
     * `publish.yml` checks out an immutable `v<version>` tag and runs this
     * suite as its "the source tree is sound" gate. By then main has usually
     * moved on -- v0.11.0 sat 25 commits behind it -- so the descends-from
     * test above is false for a commit that is nonetheless fully reviewed and
     * merged. Reading that as an unrebased branch failed the publish at the
     * step meant to certify it.
     *
     * Both halves of the condition carry weight. The tag is what an unrebased
     * branch does not have, and reachability from origin/main is what a tag
     * pushed onto an arbitrary commit does not have -- the same claim
     * `publish.yml` proves independently before it gets here. Neither alone
     * is accepted, so this stays an exemption for released code rather than a
     * hole for anything checked out behind main.
     */
    headPosition = 'RELEASE_TAG';
  } else {
    conflicts.push(`feature branch ${branch || '(detached)'} does not descend from origin/main`);
  }

  if (conflicts.length > 0) {
    throw contextConflict(conflicts.join('; '));
  }

  return {
    repository,
    baselineBranch: checkpoint.baselineBranch,
    currentBranch: branch || '(detached)',
    head,
    originMain,
    checkpointMain: checkpoint.canonicalMain,
    checkpointDrift,
    headPosition,
    releaseTag: headPosition === 'RELEASE_TAG' ? releaseTag : null,
    // The verdict and the sync time are stable within a run; the age in minutes
    // is not, and the capsule is asserted to be byte-identical across calls.
    baselineFreshness: baseline.verdict,
    baselineSyncedAt: baseline.syncedAt,
    worktree: worktree ? 'DIRTY_REPORTED' : 'CLEAN',
  };
}

/**
 * `options` is forwarded verbatim to `validateGitState`, so a caller that
 * already knows the answer to the freshness question can supply it: `now` and
 * `maxAgeMs` pin the measurement instead of reading the wall clock. The CLI
 * passes nothing and keeps the thirty minute default; a test that asserts the
 * capsule's *shape* passes `maxAgeMs: 0` so its result stops depending on how
 * long ago someone last fetched (#1291).
 */
function inspectGitState(checkpoint, options = {}) {
  const evidence = {
    repository: normalizeGitHubRepository(
      requireGitEvidence('remote.origin.url', ['config', '--get', 'remote.origin.url']),
    ),
    branch: requireGitEvidence('current branch', ['branch', '--show-current']),
    head: requireGitEvidence('HEAD', ['rev-parse', 'HEAD']),
    originMain: requireGitEvidence('origin/main', ['rev-parse', 'origin/main']),
    releaseTag: readReleaseTag(),
    worktree: requireGitEvidence('worktree status', ['status', '--short']),
    baselineSyncedAt: readBaselineSyncedAt(),
  };
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };

  return validateGitState(checkpoint, evidence, isAncestor, options);
}

function formatContextCapsule(canon, checkpoint, gitState, deliveryProtocol = '') {
  const normalizedCheckpoint = JSON.stringify(checkpoint, null, 2);
  const normalizedGitState = JSON.stringify(gitState, null, 2);

  return [
    '# HUQAN Agent Context Capsule',
    '',
    `CANON_SHA256: ${sha256(canon)}`,
    `PROTOCOL_SHA256: ${sha256(deliveryProtocol)}`,
    '',
    '## Stable Canon',
    '',
    canon,
    '',
    '## Stable Delivery Protocol',
    '',
    deliveryProtocol,
    '',
    '## Mutable Checkpoint',
    '',
    `CHECKPOINT_SHA256: ${sha256(normalizedCheckpoint)}`,
    '',
    '```json',
    normalizedCheckpoint,
    '```',
    '',
    '## Live Git Validation',
    '',
    '```json',
    normalizedGitState,
    '```',
    '',
  ].join('\n');
}

function buildContextCapsule(options = {}) {
  const canon = options.canon || readUtf8(canonPath);
  const deliveryProtocol = options.deliveryProtocol || readUtf8(deliveryProtocolPath);
  const checkpoint = options.checkpoint
    || JSON.parse(readUtf8(checkpointPath));
  const gitState = options.gitState || inspectGitState(checkpoint, options.gitStateOptions);

  return formatContextCapsule(canon, checkpoint, gitState, deliveryProtocol);
}

if (require.main === module) {
  try {
    process.stdout.write(buildContextCapsule());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'CONTEXT_CONFLICT' ? 2 : 1;
  }
}

module.exports = {
  DEFAULT_BASELINE_MAX_AGE_MINUTES,
  assessBaselineFreshness,
  buildContextCapsule,
  formatContextCapsule,
  inspectGitState,
  isReleaseCheckout,
  readBaselineSyncedAt,
  readReleaseTag,
  resolveBaselineMaxAgeMs,
  validateGitState,
};
