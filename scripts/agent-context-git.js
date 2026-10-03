'use strict';

// Git-state evidence and validation for scripts/agent-context.js (#2221):
// the release-checkout shapes, the evidence collectors and the ancestry /
// freshness / identity check that fails closed with CONTEXT_CONFLICT. Moved
// out of agent-context.js unchanged.

const { runGit, normalizeGitHubRepository, contextConflict } = require('./agent-context-primitives');
const {
  resolveBaselineMaxAgeMs,
  BASELINE_REFRESH_COMMAND,
  readBaselineSyncedAt,
  assessBaselineFreshness,
} = require('./agent-context-baseline');

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

function validateGitState(
  checkpoint,
  evidence,
  isAncestor,
  options = {},
  hasCommit = () => true,
  isShallow = () => false,
) {
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
  } else if (!hasCommit(checkpoint.canonicalMain)) {
    /**
     * The checkpoint commit is not in this clone, so the ancestry question
     * cannot be answered either way (#3368).
     *
     * A shallow checkout (`fetch-depth: 1` -- the Coverage job) holds only the
     * tip of main, so a checkpoint commit a few merges back is absent and
     * `merge-base --is-ancestor` exits 128. Reading that as "not an ancestor"
     * turned a clone-plumbing fact into a hard CONTEXT_CONFLICT on a checkpoint
     * that is, on the real repository, a valid ancestor of main: the same
     * unchanged tree passed or failed with how deep the checkout happened to
     * be, which is what made the suite flaky.
     *
     * The absence alone is not evidence of shallowness: a commit missing from a
     * *complete* clone is a real conflict, not an unanswerable question, so the
     * unverified verdict is reserved for `--is-shallow-repository`. This stays
     * honest rather than green: the branch-position checks below still fail
     * closed when the local checkout genuinely trails origin/main, and a
     * complete clone that cannot find the checkpoint keeps its conflict.
     */
    if (isShallow()) {
      checkpointDrift = 'UNVERIFIED_IN_SHALLOW_CLONE';
    } else {
      conflicts.push(
        `checkpoint main ${checkpoint.canonicalMain} is not present in this clone`,
      );
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
  // Distinguishes "this commit is not an ancestor" from "this commit is not in
  // the clone at all": `rev-parse --verify` succeeds only when the object is
  // present, so a shallow checkout answers false here where the ancestry test
  // merely exited non-zero (#3368).
  const hasCommit = (sha) => {
    try {
      runGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  // A commit absent from a shallow clone is a plumbing fact, but the same
  // absence in a complete clone is a real conflict; only the repository's own
  // answer to `--is-shallow-repository` separates the two (#3368).
  const isShallow = () => {
    try {
      return runGit(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
      return false;
    }
  };

  return validateGitState(checkpoint, evidence, isAncestor, options, hasCommit, isShallow);
}

module.exports = {
  isReleaseCheckout,
  readReleaseTag,
  requireGitEvidence,
  validateGitState,
  inspectGitState,
};
