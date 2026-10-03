const Agent = require('./agent');
const AgentV3 = require('./agent.v3');
const HuqanStorage = require('./storage');
const { createWorkflowRuntime } = require('./workflow-runtime');
const { createExperienceJournal } = require('./lib/experience/journal');
const { budgetExperienceJournal } = require('./lib/experience/budgeted-journal');
const { openJournalConnection } = require('./lib/experience/journal-connection');
const { createOperationLedger } = require('./lib/experience/reconciliation');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');

/**
 * #329 (arch-4), criterion 2: createAgent() used to hand callers either Agent
 * or AgentV3 depending on HUQAN_AGENT_VERSION, so an agent's loop-budget,
 * checkpoint and approval semantics turned on an env var. That selection is
 * gone.
 *
 * AgentV3 is the canonical agent. Agent (agent.js) remains only as the
 * internal implementation AgentV3 wraps as its baseAgent — it is not a runtime
 * option, and the direction stays one-way: AgentV3 -> Agent, never the
 * reverse.
 *
 * The runtime axis (HUQAN_AGENT_RUNTIME=workflow) is a different selector and
 * is untouched: it chooses between the agent loop and the workflow runtime,
 * not between two versions of the same agent.
 */
const CANONICAL_AGENT_VERSION = 'v3';

function assertCanonicalAgentVersion(requested, source) {
  if (requested === undefined || requested === null || requested === '') return;
  if (String(requested).toLowerCase() === CANONICAL_AGENT_VERSION) return;
  const error = new Error(
    `Agent version selection has been removed (${source}=${requested}). `
    + 'AgentV3 is the canonical agent; agent.js is an internal implementation '
    + 'detail and can no longer be selected at runtime.',
  );
  error.code = 'HUQAN_AGENT_VERSION_UNSUPPORTED';
  error.requested = String(requested);
  error.canonicalVersion = CANONICAL_AGENT_VERSION;
  throw error;
}

function resolveAgentVersion(opts = {}) {
  assertCanonicalAgentVersion(opts.version, 'options.version');
  assertCanonicalAgentVersion(readCompatibleEnvironmentVariable('AGENT_VERSION'), 'HUQAN_AGENT_VERSION');
  return CANONICAL_AGENT_VERSION;
}

function resolveAgentRuntime(opts = {}) {
  return String(opts.runtime || readCompatibleEnvironmentVariable('AGENT_RUNTIME') || 'classic').toLowerCase();
}

/**
 * Creates the canonical agent (or the workflow runtime) and wires optional
 * persistent storage.
 *
 * @param {object} [opts]
 * @returns {AgentV3|ReturnType<typeof createWorkflowRuntime>}
 */
function resolveAgentStorage(opts = {}) {
  if (opts.storage) return opts.storage;
  try {
    const storageOpts = { kernel: opts.kernel };
    if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
      storageOpts.dbPath = opts.dbPath;
    }
    return new HuqanStorage(storageOpts);
  } catch (_) {
    return null;
  }
}

/**
 * Builds the production Experience journal (#2378) from a real store, or
 * returns null when there is no durable backing. A journal needs SQLite to be
 * durable and fail-closed, so an ephemeral store (or none) means no journal:
 * fail-closed is the point, and an in-memory journal that a restart erases is
 * not that. The journal is attached to the kernel so both runtimes reach it
 * through the same place; a caller may still pass its own via opts.
 *
 * `#2375` decision 5 asks for the disabled path — "off means off rather than
 * best-effort". Off has to be *reachable*, or that confirmation is a claim
 * about a state nothing can enter. Two ways in, both explicit:
 *
 * - `opts.experienceJournal === null` — the caller turned it off by hand. An
 *   absent/`undefined` option keeps the default (build one when the store is
 *   durable); only an explicit `null` means off.
 * - `HUQAN_EXPERIENCE_ENABLED=false` — the deployment turned it off.
 *
 * With off there is no journal object at all, so the seam is a no-op and no
 * event is written. That is what makes it off rather than best-effort: there
 * is nothing left running to be slow.
 */
function resolveExperienceJournal(opts = {}, storage) {
  return resolveExperienceRuntime(opts, storage).journal;
}

/**
 * The journal and the operation ledger (#3033) are resolved together because
 * they must share one store: the ledger's intent row and the journal's step
 * events describe the same attempt, and "off" has to turn both off. The ledger
 * is handed to the agent rather than attached to the kernel, so its lifetime is
 * the agent's storage -- the same handle `closeWithStorage` closes. A caller
 * that supplies its own journal supplies its own ledger too, or runs without.
 */
function resolveExperienceRuntime(opts = {}, storage) {
  const { journal, store } = resolveExperienceJournalOption(opts, storage);
  if (journal && opts.kernel && !opts.kernel.experienceJournal) opts.kernel.experienceJournal = journal;
  if (!journal) return { journal: null, operationLedger: null };
  const operationLedger = opts.experienceOperationLedger || (store ? createOperationLedger({ store }) : null);
  return { journal, operationLedger };
}

/**
 * The journal's own EVIDENCE connection (#2915), if the factory opened one.
 * Attached to the kernel next to the journal so the restore path can close it
 * before replacing the file: it points at the same `memory.db` the graph and
 * storage hold, and Windows refuses to rename over any open handle (#1848).
 */
function attachJournalConnection(kernel, connection) {
  if (kernel && connection && !kernel.experienceJournalConnection) {
    kernel.experienceJournalConnection = connection;
  }
  return connection;
}

/**
 * The journal's handle lives exactly as long as the storage it was opened
 * beside. Nothing else closed it, so every caller that shut the agent down by
 * closing storage left `memory.db` open, and Windows then refused to delete or
 * replace the file (EBUSY). `close()` is idempotent, and restore's reopen()
 * still works after it.
 */
function closeWithStorage(storage, connection) {
  if (typeof storage.close !== 'function') return;
  const closeStorage = storage.close;
  storage.close = function closeStorageAndJournal(...args) {
    try {
      return closeStorage.apply(this, args);
    } finally {
      connection.close();
    }
  };
}

function experienceDisabled(opts) {
  if (Object.prototype.hasOwnProperty.call(opts, 'experienceJournal')) return opts.experienceJournal === null;
  return String(readCompatibleEnvironmentVariable('EXPERIENCE_ENABLED') ?? '').toLowerCase() === 'false';
}

function resolveExperienceJournalOption(opts, storage) {
  if (experienceDisabled(opts)) return { journal: null, store: null };
  if (opts.experienceJournal) return { journal: opts.experienceJournal, store: null };
  if (!storage || !storage.db) return { journal: null, store: null };
  // #2915: the journal gets its own connection at EVIDENCE, because the class
  // is per-handle and `storage.db` is RESUMABLE by choice. Falls back to the
  // storage connection when no shared path is available (an in-memory store, or
  // better-sqlite3 missing) rather than dropping the journal entirely.
  const own = openJournalConnection({ dbPath: storage.dbPath });
  if (own) {
    attachJournalConnection(opts.kernel, own);
    closeWithStorage(storage, own);
  }
  const store = own || storage;
  return { journal: budgetExperienceJournal(createExperienceJournal({ store })), store };
}

function createAgent(opts = {}) {
  // Validated before the runtime branch so a legacy version request fails the
  // same way whichever runtime it is paired with.
  resolveAgentVersion(opts);

  const runtime = resolveAgentRuntime(opts);
  const storage = resolveAgentStorage(opts);
  const { journal: experienceJournal, operationLedger } = resolveExperienceRuntime(opts, storage);
  if (runtime === 'workflow') {
    // The workflow runtime stands in for AgentV3, so it is handed the same
    // approval storage. Without it, countPendingToolApprovals() answered a
    // hard 0 while HuqanStorage held pending tool_approvals rows (#1992).
    return createWorkflowRuntime(opts.kernel, {
      ...opts,
      storage,
      experienceJournal,
      runtime: 'workflow',
      kind: 'workflow',
    });
  }

  return new AgentV3({ ...opts, storage, experienceJournal, experienceOperationLedger: operationLedger });
}

module.exports = {
  createAgent,
  resolveAgentVersion,
  resolveAgentRuntime,
  resolveExperienceJournal,
  CANONICAL_AGENT_VERSION,
  Agent,
  AgentV3,
};
