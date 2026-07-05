const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  buildAgentIdentityCoverageReport
} = require('../schemas/v5/agent-identity-coverage');

const fixturesDir = path.join(__dirname, 'fixtures', 'v5', 'agent-identity');

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
}

function listFixtureFiles() {
  return fs.readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

test('V5 agent identity coverage report is deterministic', () => {
  const first = buildAgentIdentityCoverageReport();
  const second = buildAgentIdentityCoverageReport();

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('V5 agent identity coverage report sees all fixture files', () => {
  const report = buildAgentIdentityCoverageReport();
  const fixtureFiles = listFixtureFiles();

  assert.deepEqual(report.fixtureSummary.files, fixtureFiles);
  assert.equal(report.fixtureSummary.total, fixtureFiles.length);
});

test('V5 agent identity coverage report counts valid and invalid fixtures from catalog', () => {
  const report = buildAgentIdentityCoverageReport();
  const fixtures = listFixtureFiles().map(readFixture);
  const valid = fixtures.filter((fixture) => fixture.expected_status === 'valid').length;
  const invalid = fixtures.length - valid;

  assert.equal(report.fixtureSummary.valid, valid);
  assert.equal(report.fixtureSummary.invalid, invalid);
  assert.equal(report.fixtureSummary.valid, 1);
  assert.equal(report.fixtureSummary.invalid, 5);
});

test('V5 agent identity coverage chain flags only completed identity layers', () => {
  const report = buildAgentIdentityCoverageReport();

  assert.deepEqual(report.chain, {
    fixtures: true,
    schema: true,
    validator: true,
    conformance: true,
    coverageManifest: true
  });
  assert.equal(report.validationSurface.schemaFile, 'schemas/v5/agent-identity.schema.json');
  assert.equal(report.validationSurface.validatorFile, 'schemas/v5/agent-identity-validator.js');
  assert.equal(report.validationSurface.conformanceFile, 'schemas/v5/agent-identity-conformance.js');
});

test('V5 agent identity coverage report preserves non-enforcement boundaries', () => {
  const report = buildAgentIdentityCoverageReport();

  assert.equal(report.runtimeEnforcement, false);
  assert.equal(report.connectorIdentityEnforcement, false);
  assert.equal(report.a2aIdentityExchange, false);
  assert.equal(report.marketplaceIdentityLayer, false);
  assert.equal(report.trustPackageWriterReader, false);
  assert.equal(report.agentActionPolicyEngine, false);
  assert.equal(report.nonClaims.every((claim) => claim.includes('not implemented') || claim.includes('not runtime-enforced')), true);
});

test('V5 agent identity coverage helper does not require runtime files', () => {
  const coverageModule = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity-coverage.js');
  const runtimeMarkers = [
    `${path.sep}kernel.js`,
    `${path.sep}server.js`,
    `${path.sep}mcpServer.js`,
    `${path.sep}lib${path.sep}`,
    `${path.sep}packages${path.sep}`
  ];
  const originalLoad = Module._load;
  const loaded = [];

  delete require.cache[require.resolve(coverageModule)];
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
    const fresh = require(coverageModule);
    const report = fresh.buildAgentIdentityCoverageReport();

    assert.equal(report.status, 'implementation_chain_coverage_manifest');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(coverageModule)];
  }

  assert.equal(
    loaded.some((loadedPath) => runtimeMarkers.some((marker) => loadedPath.includes(marker))),
    false
  );
});

test('V5 agent identity coverage helper is read-only planning status', () => {
  const before = listFixtureFiles()
    .map((file) => [file, fs.readFileSync(path.join(fixturesDir, file), 'utf8')]);
  const report = buildAgentIdentityCoverageReport();
  const after = listFixtureFiles()
    .map((file) => [file, fs.readFileSync(path.join(fixturesDir, file), 'utf8')]);

  assert.equal(report.schemaVersion, 'v5-agent-identity-coverage/v0.1');
  assert.equal(report.status, 'implementation_chain_coverage_manifest');
  assert.equal(report.conformanceSummary.ok, true);
  assert.deepEqual(after, before);
});
