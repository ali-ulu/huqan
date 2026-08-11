'use strict';

/**
 * Single source of truth for constructing a Kernel instance from process env
 * and caller overrides. Before this existed, server.js, cli.js, and
 * mcpServer.js each rebuilt the same env-var-to-kernel-opts mapping
 * independently (#326) — a new env var or a v2-selection rule had to be
 * copied into three places to take effect everywhere.
 */

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

function buildKernelOptsFromEnv() {
  const kernelOpts = {};
  const memoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH');
  const dbPath = readCompatibleEnvironmentVariable('DB_PATH');
  if (memoryPath) kernelOpts.memoryPath = memoryPath;
  if (dbPath) kernelOpts.dbPath = dbPath;
  if (readCompatibleEnvironmentVariable('USE_SQLITE') === 'false') kernelOpts.useSQLite = false;
  if (readCompatibleEnvironmentVariable('PARANOID') === '1') kernelOpts.paranoidMode = true;
  return kernelOpts;
}

/**
 * @param {object} [opts]
 * @param {'v2'} [opts.version]
 * @returns {Kernel|KernelV2}
 */
function createKernel(opts = {}) {
  const { version, ...kernelOpts } = opts || {};
  const selected = version || readCompatibleEnvironmentVariable('KERNEL_VERSION');
  const persistenceOpts = { ...buildKernelOptsFromEnv(), ...kernelOpts };
  return selected === 'v2' ? new KernelV2(persistenceOpts) : new Kernel(persistenceOpts);
}

module.exports = { createKernel, buildKernelOptsFromEnv };
