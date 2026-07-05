const path = require('node:path');
const {
  runAgentIdentityConformance,
  summarizeAgentIdentityConformance
} = require('./agent-identity-conformance');

const SCHEMA_VERSION = 'v5-agent-identity-coverage/v0.1';
const STATUS = 'implementation_chain_coverage_manifest';

const DEFAULT_VALIDATION_SURFACE = Object.freeze({
  schemaFile: 'schemas/v5/agent-identity.schema.json',
  validatorFile: 'schemas/v5/agent-identity-validator.js',
  conformanceFile: 'schemas/v5/agent-identity-conformance.js'
});

const NON_CLAIMS = Object.freeze([
  'Agent Identity is not runtime-enforced yet.',
  'Connector identity enforcement is not implemented yet.',
  'A2A identity exchange is not implemented yet.',
  'Marketplace identity layer is not implemented yet.',
  'Trust Package writer/reader is not implemented yet.',
  'AgentAction policy engine is not implemented yet.'
]);

function defaultRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function defaultSchemaPath(repoRoot) {
  return path.join(repoRoot, DEFAULT_VALIDATION_SURFACE.schemaFile);
}

function defaultFixturesDir(repoRoot) {
  return path.join(repoRoot, 'test', 'fixtures', 'v5', 'agent-identity');
}

function countFixtures(results) {
  const total = results.length;
  const valid = results.filter((result) => result.expected_status === 'valid').length;

  return {
    total,
    valid,
    invalid: total - valid,
    files: results.map((result) => result.file).sort()
  };
}

function buildAgentIdentityCoverageReport(options = {}) {
  const repoRoot = typeof options.repoRoot === 'string' && options.repoRoot.trim() !== ''
    ? options.repoRoot
    : defaultRepoRoot();
  const schemaPath = typeof options.schemaPath === 'string' && options.schemaPath.trim() !== ''
    ? options.schemaPath
    : defaultSchemaPath(repoRoot);
  const fixturesDir = typeof options.fixturesDir === 'string' && options.fixturesDir.trim() !== ''
    ? options.fixturesDir
    : defaultFixturesDir(repoRoot);

  const conformance = runAgentIdentityConformance({
    schemaPath,
    fixturesDir
  });
  const conformanceSummary = summarizeAgentIdentityConformance(conformance.results);

  return {
    schemaVersion: SCHEMA_VERSION,
    status: STATUS,
    runtimeEnforcement: false,
    connectorIdentityEnforcement: false,
    a2aIdentityExchange: false,
    marketplaceIdentityLayer: false,
    trustPackageWriterReader: false,
    agentActionPolicyEngine: false,
    chain: {
      fixtures: true,
      schema: true,
      validator: true,
      conformance: conformance.ok === true,
      coverageManifest: true
    },
    fixtureSummary: countFixtures(conformance.results),
    validationSurface: {
      ...DEFAULT_VALIDATION_SURFACE
    },
    conformanceSummary,
    nonClaims: [...NON_CLAIMS]
  };
}

module.exports = {
  buildAgentIdentityCoverageReport
};
