#!/usr/bin/env node

const path = require('node:path');
const { buildAgentIdentityReadinessIndex } = require('../schemas/v5/agent-identity-readiness');

const NON_ENFORCEMENT_BOUNDARY = 'Agent Identity is not runtime-enforced yet.';

/**
 * The gate's verdict, split out from its I/O so a test can exercise it
 * directly. The four conditions are all failure modes an auditor would read as
 * "the identity chain is ready": a complete chain, an explicit refusal to claim
 * runtime enforcement, passing conformance, and the non-enforcement boundary
 * kept in the non-claims.
 */
function evaluateIdentityReadiness(readiness) {
  const conformance = readiness.coverage?.conformanceSummary || {};
  const hasNonEnforcementBoundary = Array.isArray(readiness.nonClaims)
    && readiness.nonClaims.includes(NON_ENFORCEMENT_BOUNDARY);
  const ok = readiness.agentIdentityChainComplete === true
    && readiness.readyForRuntimeEnforcement === false
    && conformance.ok === true
    && hasNonEnforcementBoundary;

  return {
    ok,
    status: readiness.status,
    readyForRuntimeEnforcement: readiness.readyForRuntimeEnforcement,
    agentIdentityChainComplete: readiness.agentIdentityChainComplete,
    implementationBoundaryClean: readiness.implementationBoundaryClean,
    conformance: {
      totalFixtures: conformance.totalFixtures,
      passed: conformance.passed,
      failed: conformance.failed,
    },
    nonEnforcementBoundary: hasNonEnforcementBoundary,
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const readiness = buildAgentIdentityReadinessIndex({ repoRoot });
  const report = evaluateIdentityReadiness(readiness);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  NON_ENFORCEMENT_BOUNDARY,
  evaluateIdentityReadiness,
  main,
};
