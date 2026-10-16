'use strict';

/**
 * Single source of truth for constructing a Kernel instance from process env
 * and caller overrides. Before this existed, server.js, cli.js, and
 * mcpServer.js each rebuilt the same env-var-to-kernel-opts mapping
 * independently (#326) — a new env var or a v2-selection rule had to be
 * copied into three places to take effect everywhere.
 *
 * #329 (arch-4), criterion 2: this factory used to hand callers *either*
 * Kernel or KernelV2 depending on HUQAN_KERNEL_VERSION, which meant one
 * product shipped two selectable truth models and a call path's gate/verdict
 * behavior turned on an env var. That selection is gone.
 *
 * KernelV2 is the canonical kernel. Kernel (kernel.js) remains only as the
 * internal implementation KernelV2 wraps — it is not a runtime option, and
 * the wrapping direction stays one-way: KernelV2 -> Kernel, never the
 * reverse. A caller that still asks for the old version gets a fail-fast
 * error rather than a silently different runtime.
 */

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const CANONICAL_KERNEL_VERSION = 'v2';

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
 * An absent or empty selector means "the canonical runtime", which is what
 * every caller now gets. An explicit selector is only accepted when it names
 * the canonical version; anything else was a request for a runtime that is no
 * longer selectable, and answering it with the canonical kernel anyway would
 * be the silent substitution #329 is about.
 */
function assertCanonicalKernelVersion(requested, source) {
  if (requested === undefined || requested === null || requested === '') return;
  if (String(requested).toLowerCase() === CANONICAL_KERNEL_VERSION) return;
  const error = new Error(
    `Kernel version selection has been removed (${source}=${requested}). `
    + 'KernelV2 is the canonical kernel; Kernel v1 is an internal implementation '
    + 'detail and can no longer be selected at runtime.',
  );
  error.code = 'HUQAN_KERNEL_VERSION_UNSUPPORTED';
  error.requested = String(requested);
  error.canonicalVersion = CANONICAL_KERNEL_VERSION;
  throw error;
}

/**
 * @param {object} [opts]
 * @param {'v2'} [opts.version] Accepted only as the canonical version; any
 *   other value throws HUQAN_KERNEL_VERSION_UNSUPPORTED.
 * @returns {KernelV2}
 */
function createKernel(opts = {}) {
  const { version, ...kernelOpts } = opts || {};
  assertCanonicalKernelVersion(version, 'options.version');
  assertCanonicalKernelVersion(readCompatibleEnvironmentVariable('KERNEL_VERSION'), 'HUQAN_KERNEL_VERSION');
  return new KernelV2({ ...buildKernelOptsFromEnv(), ...kernelOpts });
}

module.exports = {
  createKernel,
  buildKernelOptsFromEnv,
  CANONICAL_KERNEL_VERSION,
  Kernel,
  KernelV2,
};
