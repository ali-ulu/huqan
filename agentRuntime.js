const Agent = require('./agent');
const AgentV3 = require('./agent.v3');
const AxiomStorage = require('./storage');
const { createWorkflowRuntime } = require('./workflow-runtime');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');

function resolveAgentVersion(opts = {}) {
  return String(opts.version || readCompatibleEnvironmentVariable('AGENT_VERSION') || 'v2').toLowerCase();
}

function resolveAgentRuntime(opts = {}) {
  return String(opts.runtime || readCompatibleEnvironmentVariable('AGENT_RUNTIME') || 'classic').toLowerCase();
}

/**
 * Creates the requested agent runtime and wires optional persistent storage.
 *
 * @param {object} [opts]
 * @returns {Agent|AgentV3}
 */
function createAgent(opts = {}) {
  const runtime = resolveAgentRuntime(opts);
  if (runtime === 'workflow') {
    return createWorkflowRuntime(opts.kernel, {
      ...opts,
      runtime: 'workflow',
      kind: 'workflow',
    });
  }

  const version = resolveAgentVersion(opts);
  const storage = opts.storage || (() => {
    try {
      const storageOpts = { kernel: opts.kernel };
      if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
        storageOpts.dbPath = opts.dbPath;
      }
      return new AxiomStorage(storageOpts);
    } catch (_) {
      return null;
    }
  })();
  if (version === 'v3') {
    return new AgentV3({ ...opts, storage });
  }
  return new Agent({ ...opts, storage });
}

module.exports = {
  createAgent,
  resolveAgentVersion,
  resolveAgentRuntime,
  Agent,
  AgentV3,
};
