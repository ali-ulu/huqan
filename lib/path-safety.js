const fs = require('fs');
const path = require('path');

function createPathError(code, message, rootPath, candidatePath) {
  const err = new Error(message);
  err.code = code;
  if (rootPath) err.rootPath = rootPath;
  if (candidatePath) err.path = candidatePath;
  return err;
}

// The containment gate admits bounded, control-character-free path strings.
// `lib/connector-local-path.js` already applied exactly this rule on the
// connector surface, but the shared gate did not: a NUL byte or an overlong
// path reached fs.existsSync/fs.realpathSync here and surfaced as an opaque
// filesystem error instead of a fail-closed path rejection (#3485). Keeping
// the rule on the one gate every containment check flows through is the point.
const MAX_PATH_LENGTH = 1024;
// oxlint-disable-next-line no-control-regex -- deliberate: the control-character class a path may not contain
const PATH_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function isBoundedPathText(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= MAX_PATH_LENGTH && !PATH_CONTROL_PATTERN.test(value);
}

function isPathWithinRoot(rootPath, candidatePath) {
  const absRoot = path.resolve(String(rootPath || ''));
  const absCandidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(absRoot, absCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// #4222 (CWE-59): lstat succeeds where existsSync failed only for a link whose
// target is gone; resolving it as a missing path would let allowMissing write
// through the link to wherever it points, so fail closed instead.
function assertNotDanglingSymlink(missingPath) {
  try { fs.lstatSync(missingPath); } catch (_) { return; }
  throw createPathError('DANGLING_SYMLINK', 'Dangling symlink target does not exist', null, missingPath);
}

function canonicalizePath(candidatePath, allowMissing) {
  const absolute = path.resolve(String(candidatePath || ''));
  let existing = absolute;
  const missing = [];
  while (!fs.existsSync(existing)) {
    assertNotDanglingSymlink(existing);
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw createPathError('PATH_NOT_FOUND', 'Path does not exist', null, absolute);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  if (!allowMissing && missing.length) {
    throw createPathError('PATH_NOT_FOUND', 'Path does not exist', null, absolute);
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

/**
 * Expand granted roots with their real-path spellings, so a canonical
 * candidate under a symlinked root (macOS /var -> /private/var) still
 * matches. Order is resolved spellings first, then real ones, de-duplicated;
 * the last element is therefore the canonical spelling of the last entry.
 * Same convention as getCliReadRoots in lib/cli-helpers.js. This only
 * widens the spelling of already-granted roots -- a candidate that
 * canonicalizes outside every granted root is still rejected by the caller.
 */
function withRealpathSpellings(entries) {
  const resolved = [...new Set(entries.map((entry) => path.resolve(entry)))];
  const real = resolved.map((entry) => {
    try { return fs.realpathSync(entry); } catch (_) { return entry; }
  });
  return [...new Set([...resolved, ...real])];
}

function resolvePathWithinRoot(rootPath, candidatePath, opts = {}) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) throw createPathError('ROOT_PATH_REQUIRED', 'rootPath is required', null, candidatePath);
  if (!isBoundedPathText(rootPath)) throw createPathError('ROOT_PATH_MALFORMED', 'rootPath contains control characters or exceeds the maximum length', null, candidatePath);
  const absRoot = path.resolve(rootPath);

  if (!isBoundedPathText(candidatePath)) throw createPathError('PATH_MALFORMED', 'candidate path contains control characters or exceeds the maximum length', absRoot, candidatePath);
  const absCandidate = path.resolve(candidatePath);
  const canonicalRoot = canonicalizePath(absRoot, true);
  // A candidate already spelled through the root's real path (a walker
  // descending realpath'd directories, macOS /var -> /private/var) is inside.
  if (!isPathWithinRoot(absRoot, absCandidate) && !isPathWithinRoot(canonicalRoot, absCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', absRoot, absCandidate);
  }

  const canonicalCandidate = canonicalizePath(absCandidate, opts.allowMissing === true);
  if (!isPathWithinRoot(canonicalRoot, canonicalCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', canonicalRoot, canonicalCandidate);
  }
  return canonicalCandidate;
}

/**
 * Read a regular file that must live inside `rootPath` (#4247, CWE-22).
 *
 * `resolvePathWithinRoot` answers "where does this path land"; this answers
 * "may I read the bytes there". Containment alone misses three refusals a
 * reader of attacker-named paths needs:
 *
 *  - a final-component symlink. `resolvePathWithinRoot` realpaths it and would
 *    admit a link whose target is inside the root, but a link is not the file
 *    the caller claimed to read, so it is refused outright; `O_NOFOLLOW` and
 *    the `dev`/`ino` comparison below also close the swap between check and
 *    read.
 *  - a non-regular file. A FIFO would block `open` forever, which is the
 *    denial of service in #4247. `O_NONBLOCK` makes that open return so the
 *    descriptor can be judged, and a regular-file read cannot block, so the
 *    type gate is also the timeout.
 *  - a path that resolves outside the root through a symlinked parent.
 *
 * @throws {Error & {code: string}} PATH_NOT_FOUND, PATH_SYMLINK,
 *   PATH_NOT_REGULAR, PATH_CHANGED, PATH_OUTSIDE_ALLOWED_ROOT or PATH_UNREADABLE.
 */
function readFileWithinRoot(rootPath, candidatePath) {
  const absolute = path.resolve(String(rootPath || ''), String(candidatePath || ''));
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw createPathError(error && error.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'PATH_UNREADABLE', 'Path is not readable', null, absolute);
  }
  if (stat.isSymbolicLink()) throw createPathError('PATH_SYMLINK', 'Path is a symbolic link', null, absolute);
  if (!stat.isFile()) throw createPathError('PATH_NOT_REGULAR', 'Path is not a regular file', null, absolute);

  const canonical = resolvePathWithinRoot(rootPath, absolute);

  let descriptor;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error && error.code === 'ELOOP') throw createPathError('PATH_SYMLINK', 'Path is a symbolic link', null, absolute);
    throw createPathError('PATH_UNREADABLE', 'Path is not readable', null, absolute);
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw createPathError('PATH_NOT_REGULAR', 'Path is not a regular file', null, absolute);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw createPathError('PATH_CHANGED', 'Path changed between check and read', null, absolute);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) throw createPathError('PATH_CHANGED', 'Path changed during read', null, absolute);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  canonicalizePath,
  createPathError,
  isPathWithinRoot,
  readFileWithinRoot,
  resolvePathWithinRoot,
  withRealpathSpellings,
};
