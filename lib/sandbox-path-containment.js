'use strict';

/**
 * Path containment for the sandbox isolation classifier.
 *
 * Extracted from lib/sandbox-isolation.js, which is over the large-file
 * threshold recorded in scripts/file-size-baseline.json and may not grow
 * further (#328). Containment is also the part of that classifier most worth
 * reading on its own: it is the check that decides whether an artifact lives
 * inside the sandbox at all.
 */

const fs = require('fs');
const path = require('path');

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\/;

function looksLikeSandboxPath(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

/**
 * The path grammar a value is written in.
 *
 * `path.win32` used to be hardcoded here (#1290), which is the wrong grammar on
 * a POSIX host: backslash is a separator in one and a legal filename character
 * in the other, and win32.resolve prefixes a drive letter a POSIX path does not
 * have. But the host's own grammar is not right either -- this classifier
 * describes a sandbox that may have run on a different OS than the one
 * evaluating the record, so a Windows path has to stay readable on Linux and
 * the reverse. The shape of the value decides.
 *
 * @param {string} value
 * @returns {path.PlatformPath}
 */
function flavorOf(value) {
  const raw = String(value).trim();
  if (WINDOWS_ABSOLUTE.test(raw) || UNC.test(raw)) return path.win32;
  if (raw.includes('\\') && !raw.includes('/')) return path.win32;
  return path.posix;
}

function normalizeSandboxPath(value) {
  if (!looksLikeSandboxPath(value)) return '';
  const raw = String(value).trim();
  return flavorOf(raw).normalize(raw);
}

/**
 * The real location of a path, when it exists.
 *
 * Lexical resolution alone is symlink-blind: `sandboxRoot/link -> /etc` reads
 * as inside the sandbox, which is fail-open in a containment classifier. When
 * the path does not exist -- normal for this classifier, which sees planned
 * artifact paths as often as real ones, and always for a path written in a
 * grammar this host does not use -- the lexical form is the only answer
 * available and is returned unchanged.
 *
 * @param {string} resolved An already resolved absolute path.
 * @returns {string}
 */
function realPathOrSelf(resolved) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (_) {
    return resolved;
  }
}

function isPathTraversal(candidatePath) {
  if (!looksLikeSandboxPath(candidatePath)) return false;
  const raw = String(candidatePath).trim();
  return /(^|[\\/])\.\.([\\/]|$)/.test(raw) || raw.startsWith('..');
}

function isInsideSandbox(candidatePath, sandboxRoot) {
  const candidate = normalizeSandboxPath(candidatePath);
  const root = normalizeSandboxPath(sandboxRoot);
  if (!candidate || !root) return false;

  const flavor = flavorOf(root);
  // Two paths written in different grammars cannot be compared, and a mismatch
  // is itself suspicious, so it reads as "outside" rather than being coerced.
  if (flavorOf(candidate) !== flavor) return false;

  const resolvedRoot = realPathOrSelf(flavor.resolve(root));
  const resolvedCandidate = realPathOrSelf(flavor.resolve(candidate));
  // Both sides go through realpath, so a symlinked sandbox root still contains
  // its own children and a symlink pointing out of the sandbox does not.
  const relative = flavor.relative(resolvedRoot, resolvedCandidate);
  return !relative
    || (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative));
}

module.exports = {
  isInsideSandbox,
  isPathTraversal,
  looksLikeSandboxPath,
  normalizeSandboxPath,
};
