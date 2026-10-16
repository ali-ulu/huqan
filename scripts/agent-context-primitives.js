'use strict';

// Plumbing for scripts/agent-context.js (#2221): the repository root, the
// UTF-8 read, the SHA-256 helper, the git runner, the remote normalizer and
// the CONTEXT_CONFLICT error. Moved out of agent-context.js unchanged; the
// baseline, git-state and capsule modules all build on these.

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

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

module.exports = {
  repoRoot,
  readUtf8,
  sha256,
  runGit,
  normalizeGitHubRepository,
  contextConflict,
};
