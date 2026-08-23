'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('./path-safety');

const DEFAULT_LIMITS = Object.freeze({
  maxTraversalDepth: 128,
  maxTraversalDirectories: 10_000,
  maxTraversalEntries: 50_000,
  maxTraversalFiles: 10_000,
});

const compareCodePoints = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${name} must be a positive safe integer`);
    error.code = 'INVALID_TRAVERSAL_LIMIT';
    throw error;
  }
  return value;
}

function traversalError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function filesystemIdentity(realPath, stat) {
  if (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino)
    && (stat.dev !== 0 || stat.ino !== 0)) {
    return `${stat.dev}:${stat.ino}`;
  }
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

/**
 * Deterministically lists matching files below an approved root. Directory and
 * file symlinks may be followed only when their canonical target stays inside
 * the root. Canonical filesystem identities prevent cycles and duplicate work.
 */
function listFilesWithinRoot(targetPath, options = {}) {
  const rootPath = options.rootPath || options.allowedRoot || options.workspaceRoot;
  if (!rootPath) throw new Error('rootPath is required');
  if (typeof options.matchesFile !== 'function') {
    throw new TypeError('matchesFile is required');
  }

  const limits = {
    maxTraversalDepth: positiveInteger(
      options.maxTraversalDepth,
      DEFAULT_LIMITS.maxTraversalDepth,
      'maxTraversalDepth',
    ),
    maxTraversalDirectories: positiveInteger(
      options.maxTraversalDirectories,
      DEFAULT_LIMITS.maxTraversalDirectories,
      'maxTraversalDirectories',
    ),
    maxTraversalEntries: positiveInteger(
      options.maxTraversalEntries,
      DEFAULT_LIMITS.maxTraversalEntries,
      'maxTraversalEntries',
    ),
    maxTraversalFiles: positiveInteger(
      options.maxTraversalFiles,
      DEFAULT_LIMITS.maxTraversalFiles,
      'maxTraversalFiles',
    ),
  };

  const absRoot = path.resolve(String(rootPath));
  const absTarget = resolvePathWithinRoot(absRoot, targetPath, { allowMissing: true });
  if (!fs.existsSync(absTarget)) return [];

  const files = [];
  const visitedDirectories = new Set();
  const visitedFiles = new Set();
  let entryCount = 0;

  const addFile = (candidatePath, stat) => {
    const realFile = resolvePathWithinRoot(absRoot, candidatePath);
    const identity = filesystemIdentity(realFile, stat || fs.statSync(realFile));
    if (visitedFiles.has(identity)) return;
    visitedFiles.add(identity);
    if (visitedFiles.size > limits.maxTraversalFiles) {
      throw traversalError('TRAVERSAL_FILE_LIMIT', 'File traversal limit exceeded', {
        limit: limits.maxTraversalFiles,
      });
    }
    if (options.matchesFile(realFile)) files.push(realFile);
  };

  const walk = (candidatePath, depth) => {
    if (depth > limits.maxTraversalDepth) {
      throw traversalError('TRAVERSAL_DEPTH_LIMIT', 'Directory traversal depth exceeded', {
        limit: limits.maxTraversalDepth,
      });
    }

    const realDirectory = resolvePathWithinRoot(absRoot, candidatePath);
    const directoryStat = fs.statSync(realDirectory);
    const identity = filesystemIdentity(realDirectory, directoryStat);
    if (visitedDirectories.has(identity)) return;
    visitedDirectories.add(identity);
    if (visitedDirectories.size > limits.maxTraversalDirectories) {
      throw traversalError('TRAVERSAL_DIRECTORY_LIMIT', 'Directory traversal limit exceeded', {
        limit: limits.maxTraversalDirectories,
      });
    }

    const entries = fs.readdirSync(realDirectory, { withFileTypes: true })
      .slice()
      .sort((a, b) => compareCodePoints(a.name, b.name));
    entryCount += entries.length;
    if (entryCount > limits.maxTraversalEntries) {
      throw traversalError('TRAVERSAL_ENTRY_LIMIT', 'Directory entry traversal limit exceeded', {
        limit: limits.maxTraversalEntries,
      });
    }

    for (const entry of entries) {
      const absEntry = path.join(realDirectory, entry.name);
      const entryStat = fs.lstatSync(absEntry);
      if (entryStat.isSymbolicLink()) {
        const realEntry = resolvePathWithinRoot(absRoot, absEntry);
        const realStat = fs.statSync(realEntry);
        if (realStat.isDirectory()) walk(realEntry, depth + 1);
        else if (realStat.isFile()) addFile(realEntry, realStat);
      } else if (entryStat.isDirectory()) {
        walk(absEntry, depth + 1);
      } else if (entryStat.isFile()) {
        addFile(absEntry, entryStat);
      }
    }
  };

  const targetStat = fs.lstatSync(absTarget);
  if (targetStat.isSymbolicLink()) {
    const realTarget = resolvePathWithinRoot(absRoot, absTarget);
    const realStat = fs.statSync(realTarget);
    if (realStat.isDirectory()) walk(realTarget, 0);
    else if (realStat.isFile()) addFile(realTarget, realStat);
  } else if (targetStat.isDirectory()) {
    walk(absTarget, 0);
  } else if (targetStat.isFile()) {
    addFile(absTarget, targetStat);
  }

  return files.sort(compareCodePoints);
}

module.exports = {
  DEFAULT_LIMITS,
  listFilesWithinRoot,
};
