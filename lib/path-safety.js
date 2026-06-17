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

function resolvePathWithinRoot(rootPath, candidatePath, opts = {}) {
  const absRoot = path.resolve(String(rootPath || ''));
  if (!absRoot) {
    throw createPathError('ROOT_PATH_REQUIRED', 'rootPath is required', absRoot, candidatePath);
  }

  const absCandidate = path.resolve(String(candidatePath || ''));
  if (!isPathWithinRoot(absRoot, absCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', absRoot, absCandidate);
  }

  if (!fs.existsSync(absCandidate)) {
    if (opts.allowMissing) {
      return absCandidate;
    }
    throw createPathError('PATH_NOT_FOUND', 'Path does not exist', absRoot, absCandidate);
  }

  const realCandidate = fs.realpathSync(absCandidate);
  if (!isPathWithinRoot(absRoot, realCandidate)) {
    throw createPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path escapes allowed root', absRoot, realCandidate);
  }

  return realCandidate;
}

module.exports = {
  createPathError,
  isPathWithinRoot,
  resolvePathWithinRoot,
};
