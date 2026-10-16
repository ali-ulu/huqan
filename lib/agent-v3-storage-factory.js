'use strict';

/**
 * Composition root for AgentV3's default durable storage (#2143, #2118).
 *
 * AgentV3 used to build its own HuqanStorage when none was injected. The
 * default is unchanged -- it opens its own SQLite handle at `opts.dbPath`, or
 * next to the kernel graph's memory file, or at `<cwd>/memory.db` -- but
 * constructing it is now this module's job, so agent.v3.js receives a store
 * rather than building one. An injected `opts.storage` still wins.
 */

const path = require('path');
const HuqanStorage = require('../storage');

function defaultAgentV3DbPath(kernel) {
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return graphMemoryPath.replace(/\.json$/, '.db');
  }
  return path.join(process.cwd(), 'memory.db');
}

function createDefaultAgentV3Storage(kernel, opts = {}) {
  return new HuqanStorage({
    kernel,
    dbPath: opts.dbPath || defaultAgentV3DbPath(kernel),
  });
}

module.exports = { defaultAgentV3DbPath, createDefaultAgentV3Storage };
