'use strict';

// Where the A2A boundary's trust comes from: the configured paths and the
// receiver-owned authority file. Moved out of exchange-route.js (#2185).

const fs = require('node:fs');
const path = require('node:path');

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { MAX_BODY_BYTES } = require('./exchange-route-contract');

function sameResolvedPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Read the receiver-owned authority from an absolute, non-symlinked file.
 *
 * The path checks are the harness consumer's, kept rather than simplified: the
 * authority decides which keys are trusted, so a symlinked parent directory is
 * a way to swap the trust root without touching the configured path.
 */
function readReceiverAuthority(authorityFile) {
  if (!authorityFile || !path.isAbsolute(authorityFile)) throw new Error('absolute receiver authority required');
  const resolved = path.resolve(authorityFile);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync(parent);
  const stat = fs.lstatSync(resolved);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameResolvedPath(parentReal, parent)
      || !stat.isFile() || stat.isSymbolicLink() || !sameResolvedPath(fs.realpathSync(resolved), resolved)
      || stat.size < 1 || stat.size > MAX_BODY_BYTES) {
    throw new Error('receiver authority path is unsafe');
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size) throw new Error('receiver authority changed during read');
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * The configured paths both A2A boundaries are built from, or null.
 *
 * Shared rather than duplicated: the Agent Card advertises the exchange route,
 * so the two must agree on what "configured" means. A second copy of this
 * check that drifted would be a way to serve a card for a route that does not
 * exist (#1182).
 */
function resolveA2aBoundaryPaths(options = {}) {
  const configured = options.authorityFile !== undefined || options.replayDirectory !== undefined;
  const authorityFile = configured
    ? (options.authorityFile || '')
    : (readCompatibleEnvironmentVariable('A2A_AUTHORITY_FILE') || '');
  const replayDirectory = configured
    ? (options.replayDirectory || '')
    : (readCompatibleEnvironmentVariable('A2A_REPLAY_DIR') || '');
  if (!authorityFile || !replayDirectory) return null;
  return Object.freeze({ authorityFile, replayDirectory });
}

module.exports = Object.freeze({ readReceiverAuthority, resolveA2aBoundaryPaths });
