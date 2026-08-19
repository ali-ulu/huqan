const Agent = require('./agent');
const AgentV3 = require('./agent.v3');
const HuqanStorage = require('./storage');
const { createWorkflowRuntime } = require('./workflow-runtime');
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
function createAgent(opts = {}) {
  // Validated before the runtime branch so a legacy version request fails the
  // same way whichever runtime it is paired with.
  resolveAgentVersion(opts);

  const runtime = resolveAgentRuntime(opts);
  if (runtime === 'workflow') {
    return createWorkflowRuntime(opts.kernel, {
      ...opts,
      runtime: 'workflow',
      kind: 'workflow',
    });
  }

  const storage = opts.storage || (() => {
    try {
      const storageOpts = { kernel: opts.kernel };
      if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
        storageOpts.dbPath = opts.dbPath;
      }
      return new HuqanStorage(storageOpts);
    } catch (_) {
      return null;
    }
  })();
  return new AgentV3({ ...opts, storage });
}

module.exports = {
  createAgent,
  resolveAgentVersion,
  resolveAgentRuntime,
  CANONICAL_AGENT_VERSION,
  Agent,
  AgentV3,
};
