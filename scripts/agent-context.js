'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const canonPath = path.join(repoRoot, 'docs', 'agent-canon.md');
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

function requireGitEvidence(label, args) {
  try {
    return runGit(args);
  } catch {
    throw contextConflict(`${label} is unavailable`);
  }
}

function validateGitState(checkpoint, evidence, isAncestor) {
  const {
    repository,
    branch,
    head,
    originMain,
    worktree,
  } = evidence;
  const conflicts = [];
  let checkpointDrift = 'CURRENT';

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
    if (head !== originMain) {
      conflicts.push(`baseline HEAD expected origin/main ${originMain}, observed ${head}`);
    }
  } else if (!isAncestor(originMain, head)) {
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
    worktree: worktree ? 'DIRTY_REPORTED' : 'CLEAN',
  };
}

function inspectGitState(checkpoint) {
  const evidence = {
    repository: normalizeGitHubRepository(
      requireGitEvidence('remote.origin.url', ['config', '--get', 'remote.origin.url']),
    ),
    branch: requireGitEvidence('current branch', ['branch', '--show-current']),
    head: requireGitEvidence('HEAD', ['rev-parse', 'HEAD']),
    originMain: requireGitEvidence('origin/main', ['rev-parse', 'origin/main']),
    worktree: requireGitEvidence('worktree status', ['status', '--short']),
  };
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };

  return validateGitState(checkpoint, evidence, isAncestor);
}

function formatContextCapsule(canon, checkpoint, gitState) {
  const normalizedCheckpoint = JSON.stringify(checkpoint, null, 2);
  const normalizedGitState = JSON.stringify(gitState, null, 2);

  return [
    '# HUQAN Agent Context Capsule',
    '',
    `CANON_SHA256: ${sha256(canon)}`,
    '',
    '## Stable Canon',
    '',
    canon,
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
  const checkpoint = options.checkpoint
    || JSON.parse(readUtf8(checkpointPath));
  const gitState = options.gitState || inspectGitState(checkpoint);

  return formatContextCapsule(canon, checkpoint, gitState);
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
  buildContextCapsule,
  formatContextCapsule,
  inspectGitState,
  validateGitState,
};
