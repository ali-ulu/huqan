'use strict';

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('../lib/environment-compat');

const defaults = Object.freeze({
  HOST: '0.0.0.0',
  MEMORY_PATH: '/app/data/memory.json',
  DB_PATH: '/app/data/memory.db',
  BACKUP_DIR: '/app/data/backups',
  KERNEL_VERSION: 'v2',
  AGENT_VERSION: 'v2',
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
  return environment;
}

function main() {
  prepareContainerEnvironment();
  const server = require('../server');
  if (readCompatibleEnvironmentVariable('DISABLE_AUTO_LISTEN') !== '1') {
    server.startServer();
  }
}

if (require.main === module) main();

module.exports = { prepareContainerEnvironment };
