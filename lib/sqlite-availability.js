'use strict';

/**
 * Turns a failed `require('better-sqlite3')` into an actionable message.
 *
 * better-sqlite3 is a native addon, so it fails in two very different ways
 * that a bare "better-sqlite3 is required" message flattens into one:
 *
 *   MODULE_NOT_FOUND      - never installed (npm ci not run, or a prod install
 *                           that pruned it). Fix: install.
 *   ERR_DLOPEN_FAILED /   - installed, but the compiled binary does not match
 *   NODE_MODULE_VERSION     this Node runtime, usually because the user
 *                           switched Node major versions after installing, or
 *                           because no prebuilt binary matched the platform and
 *                           the local build used a different ABI.
 *                           Fix: rebuild, not reinstall.
 *
 * Telling those apart is the whole point: the second case is the one where a
 * user stares at a raw node-gyp dump and concludes the product is broken.
 *
 * This module deliberately does not attempt a fallback backend. See the
 * `node:sqlite` note in the module docs of `lib/quickstart.js`'s sibling
 * report: swapping backends is a storage-semantics change, not a message
 * change, and it is out of scope here.
 */

/** @param {unknown} error the error thrown by require('better-sqlite3') */
function describeSqliteLoadFailure(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  const message = error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error || '');

  const abiMismatch = code === 'ERR_DLOPEN_FAILED'
    || /NODE_MODULE_VERSION|was compiled against a different Node|invalid ELF header|not a valid Win32 application/i.test(message);

  if (abiMismatch) {
    return {
      kind: 'abi_mismatch',
      hint: [
        `better-sqlite3 is installed but its native binary does not match this Node runtime (${process.version}).`,
        'This usually means Node was upgraded after the install. Rebuild it:',
        '  npm rebuild better-sqlite3',
        'If that fails, reinstall from scratch:',
        '  rm -rf node_modules && npm ci',
      ].join('\n'),
    };
  }

  if (code === 'MODULE_NOT_FOUND') {
    return {
      kind: 'not_installed',
      hint: [
        'better-sqlite3 is not installed. Install dependencies first:',
        '  npm ci',
        'If the install fails while compiling, no prebuilt binary matched this',
        `platform (${process.platform}-${process.arch}, Node ${process.version}) and a C++ toolchain is required.`,
        'Node.js 22 LTS or 24 LTS have the widest prebuilt coverage.',
      ].join('\n'),
    };
  }

  return {
    kind: 'unknown',
    hint: [
      `better-sqlite3 could not be loaded: ${message}`,
      'Try: npm rebuild better-sqlite3',
    ].join('\n'),
  };
}

/**
 * Loads better-sqlite3, remembering why it failed so callers can raise an
 * actionable error at the point of use instead of a bare null check.
 *
 * @returns {{Database: Function|null, loadError: unknown}}
 */
function loadSqliteDriver() {
  try {
    return { Database: require('better-sqlite3'), loadError: null };
  } catch (error) {
    return { Database: null, loadError: error };
  }
}

/**
 * @param {string} context short description of what needed SQLite, kept as the
 *   message prefix so existing callers' expectations are preserved.
 * @param {unknown} loadError
 * @returns {Error}
 */
function sqliteUnavailableError(context, loadError) {
  const { kind, hint } = describeSqliteLoadFailure(loadError);
  const error = new Error(`${context}\n\n${hint}`);
  error.code = 'HUQAN_SQLITE_UNAVAILABLE';
  error.reason = kind;
  error.cause = loadError || undefined;
  return error;
}

module.exports = {
  describeSqliteLoadFailure,
  loadSqliteDriver,
  sqliteUnavailableError,
};
