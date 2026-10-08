'use strict';

/**
 * HUQAN's own runtime persistence files, filtered out of the coder gate's
 * dirtiness view (#3642).
 *
 * `coder` reads its task from a file, and the documented invocation puts that
 * task file inside the repository. The command then opens its default durable
 * store, which lands `memory.db` (plus its WAL/SHM siblings) in the working
 * directory. The gate asked `git status` whether the tree was dirty, saw both
 * files as untracked, and refused every ordinary run with
 * `DIRTY_REPO_REVIEW_REQUIRED` before the change was even classified.
 *
 * The installation repository lists these in `.gitignore`; a user's own
 * repository has no reason to. Neither file is source the operator wrote, so
 * neither may count as dirt. Everything else untracked still does, and the
 * CLI prints it so the operator can decide what to ignore.
 *
 * The name set mirrors the memory/runtime entries in this repository's
 * `.gitignore`. A pattern is deliberately narrow: matching too broadly would
 * quietly hide real untracked source from the gate.
 */

const path = require('node:path');

const RUNTIME_ARTIFACT_NAMES = Object.freeze(new Set([
  'memory.db',
  'memory.db-shm',
  'memory.db-wal',
  'memory.json',
  'memory.embeddings.json',
  'memory.mutations.json',
  'memory.mutations.json.lock',
  'agent.memory.json',
  'test_memory.db',
]));

const RUNTIME_ARTIFACT_PATTERNS = Object.freeze([
  /^\.route-server-.*\.db$/,
  /\.agent\.json$/,
  /\.mutations\.json\.lock$/,
  /\.tmp-\d+-\d+$/,
]);

/** True when the repository-relative path is one HUQAN itself produces. */
function isRuntimeArtifact(relativePath) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  if (!normalized) return false;
  const base = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  if (RUNTIME_ARTIFACT_NAMES.has(base)) return true;
  return RUNTIME_ARTIFACT_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Split untracked paths into the ones the gate may ignore and the ones it
 * must still count. `untrackedPaths` come from `git status` and are
 * repository-relative, so they resolve against `root`; `ignoredPaths` are the
 * caller's own file arguments, resolved as the shell named them (against the
 * current working directory). An empty `ignoredPaths` entry is dropped.
 */
function partitionUntracked(untrackedPaths, { root, ignoredPaths = [] } = {}) {
  const base = path.resolve(root || process.cwd());
  const ignoredAbsolutes = new Set(
    ignoredPaths
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => path.resolve(value)),
  );
  const ignored = [];
  const remaining = [];
  for (const entry of untrackedPaths) {
    const normalized = String(entry || '').trim();
    if (!normalized) continue;
    if (ignoredAbsolutes.has(path.resolve(base, normalized)) || isRuntimeArtifact(normalized)) ignored.push(normalized);
    else remaining.push(normalized);
  }
  return { ignored, remaining };
}

module.exports = {
  RUNTIME_ARTIFACT_NAMES,
  isRuntimeArtifact,
  partitionUntracked,
};
