const fs = require('fs');
const path = require('path');

function createPathError(code, message, rootPath, candidatePath) {
  const err = new Error(message);
  err.code = code;
  if (rootPath) err.rootPath = rootPath;
  if (candidatePath) err.path = candidatePath;
  return err;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const absRoot = path.resolve(String(rootPath || ''));
  const absCandidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(absRoot, absCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalizePath(candidatePath, allowMissing) {
  const absolute = path.resolve(String(candidatePath || ''));
  let existing = absolute;
  const missing = [];
  while (!fs.existsSync(existing)) {
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

function resolvePathWithinRoot(rootPath, candidatePath, opts = {}) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) throw createPathError('ROOT_PATH_REQUIRED', 'rootPath is required', null, candidatePath);
  const absRoot = path.resolve(rootPath);

  const absCandidate = path.resolve(String(candidatePath || ''));
  if (!isPathWithinRoot(absRoot, absCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', absRoot, absCandidate);
  }

  const canonicalRoot = canonicalizePath(absRoot, true);
  const canonicalCandidate = canonicalizePath(absCandidate, opts.allowMissing === true);
  if (!isPathWithinRoot(canonicalRoot, canonicalCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', canonicalRoot, canonicalCandidate);
  }
  return canonicalCandidate;
}

module.exports = {
  createPathError,
  isPathWithinRoot,
  resolvePathWithinRoot,
};
