#!/usr/bin/env node

const path = require('node:path');
const { buildAgentIdentityReadinessIndex } = require('../schemas/v5/agent-identity-readiness');

const repoRoot = path.resolve(__dirname, '..');
const readiness = buildAgentIdentityReadinessIndex({ repoRoot });
const conformance = readiness.coverage?.conformanceSummary || {};
const hasNonEnforcementBoundary = Array.isArray(readiness.nonClaims)
  && readiness.nonClaims.includes('Agent Identity is not runtime-enforced yet.');
const ok = readiness.agentIdentityChainComplete === true
  && readiness.readyForRuntimeEnforcement === false
  && conformance.ok === true
  && hasNonEnforcementBoundary;

process.stdout.write(`${JSON.stringify({
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
}, null, 2)}\n`);

if (!ok) process.exitCode = 1;
