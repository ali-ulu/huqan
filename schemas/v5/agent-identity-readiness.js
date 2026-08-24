const {
  buildAgentIdentityCoverageReport
} = require('./agent-identity-coverage');

const SCHEMA_VERSION = 'v5-agent-identity-readiness/v0.1';
const STATUS = 'agent_identity_readiness_index';

const NEXT_GATES = Object.freeze([
  'V5-IMPL-1G Agent Identity closeout / readiness audit',
  'V5-IMPL-2A Shared Trust Package fixture/schema start'
]);

// The capabilities the implementation boundary tracks, and the name each one
// carries in the nonEnforcement view. This used to be a frozen map of literal
// `false` values that `buildBoundaryMatrix` shallow-copied, so
// `implementationBoundaryClean` -- `notCompleted.every(v => v === false)` --
// was true for every possible input: a readiness claim that could not fail
// (#1324). The list now says *what* is tracked; the values come from coverage.
const BOUNDARY_CAPABILITIES = Object.freeze([
  ['runtimeEnforcement', 'runtimeIdentity'],
  ['connectorIdentityEnforcement', 'connectorIdentity'],
  ['a2aIdentityExchange', 'a2aIdentityExchange'],
  ['marketplaceIdentityLayer', 'marketplaceIdentity'],
  ['trustPackageWriterReader', 'trustPackageWriterReader'],
  ['agentActionPolicyEngine', 'agentActionPolicyEngine']
]);

function buildCompletedMap(coverage) {
  return {
    fixtures: coverage.chain.fixtures === true,
    schema: coverage.chain.schema === true,
    validator: coverage.chain.validator === true,
    conformance: coverage.chain.conformance === true,
    coverageManifest: coverage.chain.coverageManifest === true,
    readinessIndex: true
  };
}

function buildBoundaryMatrix(coverage) {
  const notCompleted = {};
  const nonEnforcement = {};
  for (const [capability, enforcementKey] of BOUNDARY_CAPABILITIES) {
    // One measurement, two views of it. Deriving them separately is what let
    // notCompleted and nonEnforcement describe the same six capabilities with
    // opposite polarity and disagree without anything noticing.
    const completed = coverage[capability] === true;
    notCompleted[capability] = !completed;
    nonEnforcement[enforcementKey] = !completed;
  }
  return {
    completed: buildCompletedMap(coverage),
    notCompleted,
    nonEnforcement
  };
}

function buildAgentIdentityReadinessIndex(options = {}) {
  const coverage = buildAgentIdentityCoverageReport(options);
  const boundaryMatrix = buildBoundaryMatrix(coverage);
  const completedValues = Object.values(boundaryMatrix.completed);
  const notCompletedValues = Object.values(boundaryMatrix.notCompleted);

  return {
    schemaVersion: SCHEMA_VERSION,
    status: STATUS,
    readyForRuntimeEnforcement: false,
    agentIdentityChainComplete: completedValues.every((value) => value === true),
    implementationBoundaryClean: notCompletedValues.every((value) => value === false),
    boundaryMatrix,
    nextGates: [...NEXT_GATES],
    coverage: {
      schemaVersion: coverage.schemaVersion,
      status: coverage.status,
      fixtureSummary: coverage.fixtureSummary,
      conformanceSummary: coverage.conformanceSummary,
      validationSurface: coverage.validationSurface
    },
    nonClaims: [...coverage.nonClaims]
  };
}

module.exports = {
  buildAgentIdentityReadinessIndex
};
