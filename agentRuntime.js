const Agent = require('./agent');
const AgentV3 = require('./agent.v3');
const AxiomStorage = require('./storage');

function resolveAgentVersion(opts = {}) {
  return String(opts.version || process.env.AXIOM_AGENT_VERSION || 'v2').toLowerCase();
}

function createAgent(opts = {}) {
  const version = resolveAgentVersion(opts);
  const storage = opts.storage || (() => {
    try {
      return new AxiomStorage({
        kernel: opts.kernel,
        dbPath: opts.dbPath,
      });
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
  Agent,
  AgentV3,
};
