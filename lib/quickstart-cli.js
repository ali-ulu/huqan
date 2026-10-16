'use strict';

/**
 * CLI wiring for `huqan quickstart`.
 *
 * Kept out of cli.js deliberately. cli.js is over the large-file threshold
 * recorded in scripts/file-size-baseline.json, and the ratchet in
 * scripts/check-file-size.js forbids growing it further -- new code goes into
 * a module of its own. The command's actual pipeline lives in lib/quickstart.js;
 * this file is only the part that owns a throwaway store and its cleanup.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createKernel } = require('./kernel-factory');
const { runQuickstart, formatQuickstartResult } = require('./quickstart');
const { buildTrustReceipt } = require('./provenance-query');

/**
 * Run the first-run demo in a throwaway store so a brand-new user reaches a
 * real Trust Receipt without an API key, a config edit, or any risk to their
 * own memory.
 *
 * The kernel built here is deliberately a fresh one rather than the caller's:
 * quickstart must never write to canonical user memory. That isolation is
 * asserted by test/quickstart-first-run.test.js.
 *
 * @param {object} [deps] Injection seam for tests.
 * @returns {string} The formatted, user-facing result.
 */
function runQuickstartCommand(deps = {}) {
  const {
    callTool,
    createApprovalStore,
    operatorToken = '',
    createOperatorCapability,
    createDemoKernel = createKernel,
    tmpdir = os.tmpdir(),
  } = deps;

  const storeDir = fs.mkdtempSync(path.join(tmpdir, 'huqan-quickstart-'));
  let demoKernel = null;
  let demoStore = null;
  let result;
  try {
    demoKernel = createDemoKernel({
      memoryPath: path.join(storeDir, 'memory.json'),
      dbPath: path.join(storeDir, 'memory.db'),
      loadPlugins: false,
    });
    demoStore = createApprovalStore(demoKernel);
    result = runQuickstart({
      kernel: demoKernel,
      callTool,
      approvalStore: demoStore,
      operatorToken,
      createOperatorCapability,
      buildTrustReceipt,
    });
  } catch (error) {
    result = { ok: false, steps: [], error: { code: 'QUICKSTART_SETUP_FAILED', message: error?.message || String(error) } };
  } finally {
    // Cleanup must never mask the result the user came for.
    try { demoStore?.close?.(); } catch (_) { /* demo store cleanup is best-effort */ }
    try { demoKernel?.close?.(); } catch (_) { /* same */ }
  }

  // Removing the directory happens after the handles above are closed: on
  // Windows an open SQLite handle turns the removal into EPERM. The result is
  // already computed, so a failed removal can only downgrade what we claim
  // about the directory -- never the outcome the user came for.
  const storeRemoved = removeStoreDir(storeDir);
  return formatQuickstartResult(result, { storePath: storeDir, storeRemoved });
}

/**
 * Best-effort removal of the throwaway store directory.
 *
 * @param {string} storeDir
 * @returns {boolean} Whether the directory is gone.
 */
function removeStoreDir(storeDir) {
  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
    return !fs.existsSync(storeDir);
  } catch (_) {
    return false;
  }
}

module.exports = { runQuickstartCommand };
