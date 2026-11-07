'use strict';

/**
 * Fail-closed runtime guard for the documented minimum Node version (#4532).
 *
 * better-sqlite3@13.0.3 ships a NAPI 10 prebuild. On runtimes whose NAPI
 * version is below 10 (Node <= 22.13.0, all of Node 20), `new Database()`
 * dies with a silent SIGSEGV (exit 139) instead of throwing, so neither the
 * `engines` warning nor the sqlite load-failure hints ever get printed. The
 * `engines.node` check only runs during `npm install` and is skipped entirely
 * under `--ignore-scripts`, which non-compiler environments need.
 *
 * The gate therefore runs at boot, before any native module is touched, and
 * turns the segfault into an operator-readable error. The boundary is NAPI 10:
 * the issue's version matrix shows napi=9 crashing and napi=10 working.
 */

const MIN_NODE_VERSION = '22.14.0';
const MIN_NAPI_VERSION = 10;

function parseNodeVersion(version) {
  const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareNodeVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Returns why the runtime is unsupported as a plain string, or null when the
 * runtime is fine. All inputs come from process.versions or tests; nothing
 * here spawns a process or touches the filesystem.
 */
function describeUnsupportedNodeRuntime(options) {
  // Defaults only apply when no explicit versions were passed: a caller that
  // hands in a versions object with a missing field must fail closed (#4532),
  // not silently fall back to the live process values.
  const opts = options === undefined
    ? { nodeVersion: process.version, napiVersion: process.versions.napi }
    : options;
  const nodeVersion = String(opts.nodeVersion === undefined ? '' : opts.nodeVersion);
  const napi = Number(opts.napiVersion);

  // Fail closed: a runtime that will not even report its NAPI version is one
  // we cannot vouch for, and the alternative is a silent native crash later.
  if (parseNodeVersion(nodeVersion) === null || !Number.isFinite(napi)) {
    return 'Node runtime could not be identified. '
      + 'HUQAN requires Node.js >= ' + MIN_NODE_VERSION
      + ' (NAPI >= ' + MIN_NAPI_VERSION + '); '
      + 'older runtimes crash the native SQLite binding without an error message.';
  }

  // NAPI is the real crash boundary (#4532 version matrix): napi=9 segfaults
  // in better-sqlite3@13, napi=10 works. The Node version floor exists so the
  // documented minimum matches what actually runs.
  const belowNodeFloor = compareNodeVersion(
    parseNodeVersion(nodeVersion),
    parseNodeVersion('v' + MIN_NODE_VERSION),
  ) < 0;
  if (napi < MIN_NAPI_VERSION || belowNodeFloor) {
    return 'Node.js ' + nodeVersion + ' (NAPI ' + napi + ') is not supported: '
      + 'the bundled better-sqlite3 prebuild segfaults on NAPI < ' + MIN_NAPI_VERSION
      + ' instead of reporting an error. '
      + 'HUQAN requires Node.js >= ' + MIN_NODE_VERSION
      + ' (NAPI >= ' + MIN_NAPI_VERSION + ').';
  }

  return null;
}

/**
 * Throws a boot-stopping error when the current runtime cannot run the native
 * store safely. Callers print error.message verbatim.
 */
function assertSupportedNodeRuntime(versions) {
  const v = versions || process.versions;
  const reason = describeUnsupportedNodeRuntime({ nodeVersion: v.node, napiVersion: v.napi });
  if (reason) {
    const error = new Error(reason);
    error.code = 'HUQAN_NODE_UNSUPPORTED';
    throw error;
  }
}

module.exports = {
  MIN_NAPI_VERSION,
  MIN_NODE_VERSION,
  assertSupportedNodeRuntime,
  describeUnsupportedNodeRuntime,
};
