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
const { protectedMemoryPathIfSelected } = require('./protected-store-path');

function defaultAgentV3DbPath(kernel) {
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return graphMemoryPath.replace(/\.json$/, '.db');
  }
  // ADR-018 §2: a graph built without a path (a fake kernel in a test, or a
  // caller that passed none) must not drop the agent store into the working
  // directory once the protected store is selected for this workspace. The
  // graph itself already resolves the protected path, so this branch is only
  // reached when the graph named nothing at all.
  const protectedSelection = protectedMemoryPathIfSelected({ workspaceRoot: process.cwd() });
  if (protectedSelection) return protectedSelection.dbPath;
  return path.join(process.cwd(), 'memory.db');
}

function createDefaultAgentV3Storage(kernel, opts = {}) {
  return new HuqanStorage({
    kernel,
    dbPath: opts.dbPath || defaultAgentV3DbPath(kernel),
  });
}

module.exports = { defaultAgentV3DbPath, createDefaultAgentV3Storage };
