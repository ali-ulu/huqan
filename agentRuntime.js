const Agent = require('./agent');
const AgentV3 = require('./agent.v3');

function resolveAgentVersion(opts = {}) {
  return String(opts.version || process.env.AXIOM_AGENT_VERSION || 'v2').toLowerCase();
}

function createAgent(opts = {}) {
  const version = resolveAgentVersion(opts);
  if (version === 'v3') {
    return new AgentV3(opts);
  }
  return new Agent(opts);
}

module.exports = {
  createAgent,
  resolveAgentVersion,
  Agent,
  AgentV3,
};
