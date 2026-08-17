const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const {
  buildAgentIdentityReadinessIndex
} = require('../schemas/v5/agent-identity-readiness');

test('V5 agent identity readiness index is deterministic', () => {
  const first = buildAgentIdentityReadinessIndex();
  const second = buildAgentIdentityReadinessIndex();

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('V5 agent identity readiness index marks completed implementation-prep layers', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.equal(index.schemaVersion, 'v5-agent-identity-readiness/v0.1');
  assert.equal(index.status, 'agent_identity_readiness_index');
  assert.equal(index.agentIdentityChainComplete, true);
  assert.deepEqual(index.boundaryMatrix.completed, {
    fixtures: true,
    schema: true,
    validator: true,
    conformance: true,
    coverageManifest: true,
    readinessIndex: true
  });
});

test('V5 agent identity readiness index keeps runtime and ecosystem capabilities not completed', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.equal(index.readyForRuntimeEnforcement, false);
  assert.equal(index.implementationBoundaryClean, true);
  assert.deepEqual(index.boundaryMatrix.notCompleted, {
    runtimeEnforcement: false,
    connectorIdentityEnforcement: false,
    a2aIdentityExchange: false,
    marketplaceIdentityLayer: false,
    trustPackageWriterReader: false,
    agentActionPolicyEngine: false
  });
  assert.deepEqual(index.boundaryMatrix.nonEnforcement, {
    runtimeIdentity: true,
    connectorIdentity: true,
    a2aIdentityExchange: true,
    marketplaceIdentity: true,
    trustPackageWriterReader: true,
    agentActionPolicyEngine: true
  });
});

test('V5 agent identity readiness index preserves coverage evidence', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.equal(index.coverage.schemaVersion, 'v5-agent-identity-coverage/v0.1');
  assert.equal(index.coverage.status, 'implementation_chain_coverage_manifest');
  // Ratchet bump 8 -> 13 (validator extension for Gate 7's remaining classes, #846):
  // +invalid.identity_claim, delegation_scope_exceeded, delegation_chain,
  //   connector_context, unresolvable_lifecycle
  // Readiness index stays coverage-faithful; values updated to match.
  assert.equal(index.coverage.fixtureSummary.total, 13);
  assert.equal(index.coverage.fixtureSummary.valid, 2);
  assert.equal(index.coverage.fixtureSummary.invalid, 11);
  assert.deepEqual(index.coverage.conformanceSummary, {
    ok: true,
    totalFixtures: 13,
    passed: 13,
    failed: 0,
    failingFiles: []
  });
});

test('V5 agent identity readiness index declares next gates without starting them', () => {
  const index = buildAgentIdentityReadinessIndex();

  assert.deepEqual(index.nextGates, [
    'V5-IMPL-1G Agent Identity closeout / readiness audit',
    'V5-IMPL-2A Shared Trust Package fixture/schema start'
  ]);
  assert.equal(index.nonClaims.some((claim) => claim.includes('not runtime-enforced')), true);
  assert.equal(index.nonClaims.some((claim) => claim.includes('Trust Package writer/reader is not implemented')), true);
});

test('V5 agent identity readiness helper does not require runtime files', () => {
  const readinessModule = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity-readiness.js');
  const runtimeMarkers = [
    `${path.sep}kernel.js`,
    `${path.sep}server.js`,
    `${path.sep}mcpServer.js`,
    `${path.sep}lib${path.sep}`,
    `${path.sep}packages${path.sep}`
  ];
  const originalLoad = Module._load;
  const loaded = [];

  delete require.cache[require.resolve(readinessModule)];
  Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      loaded.push(resolved);
    } catch {
      // Built-in modules do not resolve to workspace paths.
    }
    return exported;
  };

  try {
    const fresh = require(readinessModule);
    const index = fresh.buildAgentIdentityReadinessIndex();

    assert.equal(index.status, 'agent_identity_readiness_index');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(readinessModule)];
  }

  assert.equal(
    loaded.some((loadedPath) => runtimeMarkers.some((marker) => loadedPath.includes(marker))),
    false
  );
});
