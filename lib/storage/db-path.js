// Where HuqanStorage's SQLite file lives, contained to the allowed roots.
// Moved out of storage.js (#2165).

const os = require('os');
const path = require('path');
const { resolveContainedPath } = require('../memory-store-utils');
const { assertStoreOpenAllowed } = require('../sqlite-persistence-validation');
const { resolveDefaultMemoryPath } = require('../default-persistence-path');

function resolveDbPath(opts = {}, kernel) {
  // os.tmpdir() is an allowed root here for the same reason it is one in
  // lib/memory-store-utils.resolveDbPath: ephemeral stores (tests, sandboxed
  // runs) legitimately live there. resolveContainedPath still canonicalizes
  // through it, so a symlink pointing out of the temp root is still rejected.
  const allowedRoots = [process.cwd(), os.tmpdir()];
  if (typeof kernel?.graph?.memoryPath === 'string' && kernel.graph.memoryPath.trim()) {
    allowedRoots.push(path.dirname(path.resolve(kernel.graph.memoryPath.trim())));
  }
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.trim()) {
    allowedRoots.push(path.dirname(path.resolve(opts.memoryPath.trim())));
  }

  if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
    return resolveContainedPath(opts.dbPath, allowedRoots);
  }
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return resolveContainedPath(graphMemoryPath.replace(/\.json$/, '.db'), allowedRoots);
  }
  // #1579: the last of the three default-path sources (the graph's and
  // MemoryStore's are the others). Under the test runner this resolves outside
  // the repository, so a storage built with no path -- as agentRuntime.test.js
  // does through a fake kernel -- stops leaving a memory.db in the working tree.
  const fallback = path.resolve(path.dirname(resolveDefaultMemoryPath()), 'memory.db');
  allowedRoots.push(path.dirname(fallback));
  const resolved = resolveContainedPath(fallback, allowedRoots);
  // Only this branch can stray: the two above return a path the caller or the
  // graph named, and this one is derived from the working directory.
  assertStoreOpenAllowed(resolved, {});
  return resolved;
}

module.exports = { resolveDbPath };
