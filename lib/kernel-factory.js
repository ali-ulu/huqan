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
const { normalizeUseSQLiteFlag } = require('./use-sqlite-flag');

const CANONICAL_KERNEL_VERSION = 'v2';

function buildKernelOptsFromEnv() {
  const kernelOpts = {};
  const memoryPath = readCompatibleEnvironmentVariable('MEMORY_PATH');
  const dbPath = readCompatibleEnvironmentVariable('DB_PATH');
  if (memoryPath) kernelOpts.memoryPath = memoryPath;
  if (dbPath) kernelOpts.dbPath = dbPath;
  // #4558: `USE_SQLITE` was mapped only for the exact string 'false', so the
  // obvious opt-in (`USE_SQLITE=1`) was silently ignored and the memory core
  // stayed ephemeral. Normalize the accepted spellings the same way MemoryStore
  // does (#4559): true/'1'/'true' opt in, false/'0'/'false' opt out, anything
  // else is refused instead of guessed. An absent/blank value leaves the option
  // undefined (the runtime default).
  const useSqliteEnv = readCompatibleEnvironmentVariable('USE_SQLITE');
  if (typeof useSqliteEnv === 'string' && useSqliteEnv.trim() !== '') {
    kernelOpts.useSQLite = normalizeUseSQLiteFlag(useSqliteEnv);
  }
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

/**
 * Report, once at boot, that the kernel's memory core will not persist.
 *
 * #4558: Graph defaults to SQLite (`useSQLite !== false`) while MemoryStore
 * defaults to the process-only backend, so a production boot with no explicit
 * SQLite choice persisted the graph and silently dropped every memory record
 * on exit. The divergence stays possible -- the memory backend is a
 * first-class mode -- but it must be visible: an operator who reads the boot
 * log learns the memory core is ephemeral before losing a record, instead of
 * inferring it from a `PERSISTENCE_DISABLED` save after the fact. The graph
 * half is only named when it really is durable, so the line never claims a
 * split that is not there. Values never enter the message.
 *
 * @param {{ graph?: object, memory?: object }} kernel a constructed kernel
 * @param {{ warn?: Function }} [sink] defaults to console
 * @returns {boolean} whether the warning was emitted
 */
function warnIfMemoryBackendEphemeral(kernel, sink = console) {
  const memory = kernel && kernel.memory;
  // Read the backend without saving: MemoryStore#save() writes the JSON file
  // when that backend is active, and a boot warning must not create a store.
  // `_storePort.backend()` is the read-only selector the port exposes.
  const port = memory && memory._storePort;
  if (!port || typeof port.backend !== 'function') return false;
  if (port.backend() !== 'memory') return false;
  // The graph's SQLite handle is private (`_db`); the existing persistence
  // tests read it the same way, and it is the only signal that distinguishes a
  // durable graph from a JSON/absent one here.
  const graphDurable = !!(kernel.graph && kernel.graph._db);
  const detail = graphDurable
    ? 'the graph persists to SQLite while memory records do not'
    : 'memory records live in this process only';
  if (sink && typeof sink.warn === 'function') {
    sink.warn(`HUQAN memory core is not persistent (backend: memory): ${detail}. `
      + 'Records are lost on exit. Set USE_SQLITE=1 (with DB_PATH) to persist them.');
  }
  return true;
}

module.exports = {
  createKernel,
  buildKernelOptsFromEnv,
  warnIfMemoryBackendEphemeral,
  CANONICAL_KERNEL_VERSION,
  Kernel,
  KernelV2,
};
