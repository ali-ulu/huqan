'use strict';

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('../lib/environment-compat');
const { enforceApiAuthOptOutPolicy } = require('../lib/api-auth-opt-out');

// AGENT_VERSION is deliberately absent (#774). agentRuntime pins AgentV3 as
// the canonical agent and rejects every non-empty selector other than 'v3', so
// defaulting the variable at all can only produce one of two wrong outcomes: a
// legacy value the factory refuses -- which is what 'v2' here did, breaking
// agent-backed endpoints in a default container the operator never configured
// -- or a second copy of the canonical literal that can drift from the
// factory's. Absence already means canonical, so absence is the default.
const defaults = Object.freeze({
  HOST: '0.0.0.0',
  MEMORY_PATH: '/app/data/memory.json',
  DB_PATH: '/app/data/memory.db',
  BACKUP_DIR: '/app/data/backups',
  KERNEL_VERSION: 'v2',
  TRUST_PROXY: '0',
});

function prepareContainerEnvironment(environment = process.env) {
  validateEnvironmentCompatibility(environment);
  if (!readCompatibleEnvironmentVariable('API_KEY', environment)) {
    const error = new Error('HUQAN_API_KEY (or legacy AXIOM_API_KEY) is required');
    error.code = 'HUQAN_API_KEY_REQUIRED';
    throw error;
  }

  for (const [suffix, value] of Object.entries(defaults)) {
    if (readCompatibleEnvironmentVariable(suffix, environment) === undefined) {
      environment[`HUQAN_${suffix}`] = value;
    }
  }
  // #3018: this bootstrap defaults HOST to 0.0.0.0 -- exactly where the
  // API-auth opt-out becomes dangerous. HOST is explicit by the time the
  // guard runs, so a container that asks for the opt-out on the default bind
  // without HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE stops here, before any
  // listener exists.
  enforceApiAuthOptOutPolicy(environment);
  return environment;
}

function main({ environment = process.env, loadServer = () => require('../server') } = {}) {
  prepareContainerEnvironment(environment);
  const server = loadServer();
  if (readCompatibleEnvironmentVariable('DISABLE_AUTO_LISTEN', environment) !== '1') {
    server.bindGracefulShutdown();
    server.startServer();
  }
}

if (require.main === module) main();

module.exports = { main, prepareContainerEnvironment };
