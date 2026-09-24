'use strict';

// Agent context capsule: the stable-canon / delivery-protocol / checkpoint /
// live-git-state document printed for agent sessions. The plumbing lives in
// agent-context-primitives.js, baseline freshness in agent-context-baseline.js
// and git-state validation in agent-context-git.js (#2221); this file keeps
// the capsule assembly, the CLI entry point and the public facade, so the
// exported names are unchanged and in the same order.

const path = require('node:path');
const { repoRoot, readUtf8, sha256 } = require('./agent-context-primitives');
const { DEFAULT_BASELINE_MAX_AGE_MINUTES, assessBaselineFreshness, readBaselineSyncedAt, resolveBaselineMaxAgeMs } = require('./agent-context-baseline');
const { inspectGitState, isReleaseCheckout, readReleaseTag, validateGitState } = require('./agent-context-git');

const canonPath = path.join(repoRoot, 'docs', 'agent-canon.md');
const deliveryProtocolPath = path.join(repoRoot, 'docs', 'fikirden-urune-protocol.md');
const checkpointPath = path.join(repoRoot, 'docs', 'current-agent-checkpoint.json');

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
