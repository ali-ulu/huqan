'use strict';

/**
 * #3027: the headless repo-ingest approval submitter the GitHub App webhook
 * needs.
 *
 * `lib/github-app-beta-http-boundary.js` only queues a pull-request
 * observation for review when it is handed an `options.queueIngest` callback.
 * The published beta server (`github-app-server.js`) never supplied one, so a
 * real GitHub App deployment recorded the observation receipt but never
 * created the repo-memory ingest approval -- #3032's GitHub -> repo-memory ->
 * graph pipeline ran end to end only inside its own test.
 *
 * This module supplies that callback from the same approval runtime the main
 * HTTP server uses (`lib/http/ingest-approval-runtime.js`), so the gate and
 * the durable store are the product's own and not a second implementation.
 * Nothing here decides a verdict: the submission still lands `pending` for a
 * human, and `github-app-server.js`'s response shape and
 * `lib/github-app-beta-handler.js` are untouched.
 */

const path = require('path');
const { createKernel } = require('../kernel-factory');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { createIngestApprovalRuntime } = require('./ingest-approval-runtime');

/**
 * Kernel options derived from the same environment the beta store and webhook
 * read, so an operator who points the App at a store path gets the approval
 * store beside it (a `.json` path becomes `.db`, matching `HuqanStorage`).
 * `readCompatibleEnvironmentVariable` keeps the AXIOM legacy names working.
 */
function buildSubmitterKernelOptions(environment = process.env) {
  const opts = {};
  const memoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH', environment);
  const dbPath = readCompatibleEnvironmentVariable('DB_PATH', environment);
  if (typeof memoryPath === 'string' && memoryPath.trim()) opts.memoryPath = memoryPath;
  if (typeof dbPath === 'string' && dbPath.trim()) opts.dbPath = dbPath;
  if (readCompatibleEnvironmentVariable('USE_SQLITE', environment) === 'false') opts.useSQLite = false;
  return opts;
}

/**
 * Build the `queueIngest` callback for the beta HTTP boundary.
 *
 * The returned function accepts the frozen submission
 * `buildRepoIngestSubmission` produces and resolves to the same
 * `{ status, json }` shape `ingestApprovalRuntime.submit` returns; the
 * boundary maps it to the webhook's `ingest` field and a rejection still
 * leaves the observation receipt intact.
 *
 * The runtime -- and the SQLite store behind it -- is created lazily on the
 * first queued observation so that booting the server without an ingest
 * does not open a store. `companyMode`, the plugin capabilities and the
 * `plugins/` directory are only loaded when the first observation actually
 * needs them.
 *
 * @param {object} [options]
 * @param {object} [options.environment] environment to read config from
 * @param {object} [options.kernel] kernel to reuse (mainly tests)
 * @param {Function} [options.readEnvironment] `(suffix) => value`; defaults to
 *   the compat reader bound to `options.environment`
 * @param {string} [options.pluginRoot] plugin directory to load
 * @returns {(submission: object) => Promise<{status:number, json:object}>}
 */
function createRepoIngestSubmitter(options = {}) {
  const environment = options.environment || process.env;
  const readEnvironment = typeof options.readEnvironment === 'function'
    ? options.readEnvironment
    : (suffix) => readCompatibleEnvironmentVariable(suffix, environment);
  const pluginRoot = options.pluginRoot || path.join(__dirname, '..', '..', 'plugins');

  // The kernel is built on the first submission, not here: `github-app-server`
  // builds the submitter before it knows whether the beta surface is enabled,
  // and a disabled server must throw without opening a graph or a store.
  let kernel = options.kernel || null;
  let runtime = null;
  let pluginsLoaded = false;

  function getKernel() {
    if (kernel === null) {
      kernel = createKernel(buildSubmitterKernelOptions(environment));
      if (kernel.graph && typeof kernel.graph.load === 'function' && !kernel.graph.loaded) {
        kernel.graph.load();
      }
    }
    return kernel;
  }

  function ensureRuntime() {
    const activeKernel = getKernel();
    if (typeof activeKernel.hasCapability === 'function' && !activeKernel.hasCapability('companyMode')) {
      activeKernel.enableCapability('companyMode');
    }
    if (typeof activeKernel.hasCapability === 'function' && !activeKernel.hasCapability('pluginCapabilities')) {
      activeKernel.enableCapability('pluginCapabilities');
    }
    if (!pluginsLoaded && activeKernel.plugins && typeof activeKernel.plugins.load === 'function') {
      activeKernel.plugins.load(pluginRoot);
      pluginsLoaded = true;
    }
  }

  function getRuntime() {
    if (runtime === null) {
      runtime = createIngestApprovalRuntime({ kernel: getKernel(), readEnvironment, ensureRuntime });
    }
    return runtime;
  }

  async function queueIngest(submission) {
    return getRuntime().submit(submission);
  }

  /**
   * Release the SQLite store, if one was opened. Safe to call before the
   * first submission.
   */
  queueIngest.close = () => {
    if (runtime) runtime.close();
  };
  Object.defineProperty(queueIngest, 'kernel', { get: getKernel, enumerable: true });

  return queueIngest;
}

module.exports = {
  buildSubmitterKernelOptions,
  createRepoIngestSubmitter,
};
