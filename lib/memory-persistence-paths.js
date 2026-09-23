'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePathWithinRoot } = require('./path-safety');
const { resolveDefaultMemoryPath } = require('./default-persistence-path');
const { assertStoreOpenAllowed } = require('./sqlite-persistence-validation');

function siblingPersistencePath(base, suffix) {
  const text = String(base || '');
  return /\.json$/i.test(text) ? text.replace(/\.json$/i, suffix) : `${text}${suffix}`;
}

function assertDistinctPersistencePaths(paths = {}) {
  const seen = new Map();
  for (const [role, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !value) continue;
    const resolved = path.resolve(value);
    const previous = seen.get(resolved);
    if (previous) {
      throw new Error(
        `Persistence paths collide: ${previous} and ${role} both resolve to ${resolved}. `
        + 'Each would overwrite the other on save; give them distinct paths '
        + '(a memoryPath ending in .json derives the rest automatically).',
      );
    }
    seen.set(resolved, role);
  }
}

function derivePersistenceLayout(memoryPath, explicitDbPath) {
  const layout = {
    dbPath: explicitDbPath || siblingPersistencePath(memoryPath, '.db'),
    embeddingPath: siblingPersistencePath(memoryPath, '.embeddings.json'),
    journalPath: siblingPersistencePath(memoryPath, '.mutations.json'),
  };
  assertDistinctPersistencePaths({ memoryPath, ...layout });
  return layout;
}

function resolveDbPath(opts = {}) {
  const roots = [
    process.cwd(),
    os.tmpdir(),
  ];
  if (typeof opts.rootDir === 'string' && opts.rootDir.trim()) {
    roots.push(opts.rootDir.trim());
  }
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.trim()) {
    roots.push(path.dirname(path.resolve(opts.memoryPath.trim())));
  }

  const candidate = opts.dbPath
    ? opts.dbPath
    : (typeof opts.memoryPath === 'string' && opts.memoryPath.trim() && opts.memoryPath.trim().endsWith('.json'))
      ? opts.memoryPath.trim().replace(/\.json$/, '.db')
      : siblingPersistencePath(path.resolve(path.dirname(resolveDefaultMemoryPath()), 'memory.json'), '.db');

  const resolved = resolveContainedPath(candidate, roots);
  assertStoreOpenAllowed(resolved, { dbPath: opts.dbPath, memoryPath: opts.memoryPath });
  return resolved;
}

function realpathOrSelf(root) {
  try { return fs.realpathSync(root); } catch { return root; }
}

function isWithinRoot(candidate, root) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveContainedPath(candidate, allowedRoots = []) {
  const normalizedCandidate = path.resolve(candidate);
  const roots = allowedRoots
    .filter((root) => typeof root === 'string' && root.trim())
    .map((root) => path.resolve(root.trim()))
    .filter((root) => isWithinRoot(normalizedCandidate, root) || isWithinRoot(normalizedCandidate, realpathOrSelf(root)))
    .sort((left, right) => right.length - left.length);
  if (!roots.length) {
    const error = new Error('Path escapes allowed persistence roots');
    error.code = 'PATH_OUTSIDE_ALLOWED_ROOT';
    error.path = normalizedCandidate;
    throw error;
  }
  return resolvePathWithinRoot(roots[0], normalizedCandidate, { allowMissing: true });
}

module.exports = {
  resolveDbPath,
  siblingPersistencePath,
  assertDistinctPersistencePaths,
  derivePersistenceLayout,
  resolveContainedPath,
};
