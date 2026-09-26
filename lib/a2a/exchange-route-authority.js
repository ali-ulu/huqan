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
  // Open first and judge the descriptor, not the name: every check below is
  // about the file this descriptor reads, so a swap after a check cannot
  // change what is trusted. A final symlink is refused by O_NOFOLLOW where the
  // platform has it and by the realpath comparison everywhere.
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && error.code === 'ELOOP') throw new Error('receiver authority path is unsafe');
    throw error;
  }
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    const parentStat = fs.lstatSync(parent);
    const parentReal = fs.realpathSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameResolvedPath(parentReal, parent)
        || !opened.isFile() || !sameResolvedPath(fs.realpathSync(resolved), resolved)
        || opened.size < 1 || opened.size > MAX_BODY_BYTES) {
      throw new Error('receiver authority path is unsafe');
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) throw new Error('receiver authority changed during read');
  } finally {
    fs.closeSync(fd);
  }
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
