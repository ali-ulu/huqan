const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const matrixPath = path.join(__dirname, '..', 'schemas', 'v5', 'shared-trust-package-conformance-matrix.json');

function readMatrix() {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
}

const requiredRowFields = [
  'id',
  'contractArea',
  'sourceDocument',
  'schemaCoverage',
  'fixtureCoverage',
  'validatorCoverage',
  'testCoverage',
  'currentStatus',
  'futureGate',
  'runtimeClaimAllowed'
];

const runtimeBoundaryTerms = [
  'runtime',
  'writer',
  'reader',
  'signing',
  'verification',
  'a2a',
  'connector',
  'marketplace',
  'agentaction'
];

const requiredNonClaims = [
  'runtime writer',
  'runtime reader',
  'signing runtime',
  'verification runtime',
  'A2A',
  'connector enforcement',
  'marketplace',
  'AgentAction policy engine'
];

test('V5 Shared Trust Package conformance matrix JSON parses and has expected top-level shape', () => {
  const matrix = readMatrix();

  assert.equal(typeof matrix, 'object');
  assert.equal(Array.isArray(matrix), false);
  assert.equal(typeof matrix.schemaVersion, 'string');
  assert.match(matrix.schemaVersion, /^v5-shared-trust-package-conformance-matrix\//);
  assert.equal(matrix.artifact, 'shared-trust-package-conformance-readiness-matrix');
  assert.equal(typeof matrix.checkpoint, 'string');
  assert.match(matrix.checkpoint, /V5-IMPL-2D/);
  assert.equal(typeof matrix.status, 'string');
});

test('V5 Shared Trust Package conformance matrix rows have required fields and stable count', () => {
  const matrix = readMatrix();

  assert.equal(Array.isArray(matrix.rows), true);
  assert.equal(matrix.rows.length, 17);

  for (const row of matrix.rows) {
    for (const field of requiredRowFields) {
      assert.equal(Object.hasOwn(row, field), true, `${row.id || '<missing id>'} should include ${field}`);
    }

    assert.equal(typeof row.id, 'string');
    assert.notEqual(row.id.trim(), '');
    assert.equal(typeof row.contractArea, 'string');
    assert.notEqual(row.contractArea.trim(), '');
    assert.equal(typeof row.runtimeClaimAllowed, 'boolean');
  }
});

test('V5 Shared Trust Package conformance matrix runtime and ecosystem rows do not allow runtime claims', () => {
  const matrix = readMatrix();

  const runtimeRows = matrix.rows.filter((row) => {
    const haystack = `${row.id} ${row.contractArea}`.toLowerCase();
    return runtimeBoundaryTerms.some((term) => haystack.includes(term));
  });

  assert.ok(runtimeRows.length >= 7, 'expected runtime/exchange/enforcement rows to be present');

  for (const row of runtimeRows) {
    assert.equal(row.runtimeClaimAllowed, false, `${row.id} must not allow runtime claims`);
  }
});

test('V5 Shared Trust Package conformance matrix non-claims preserve required V5 boundaries', () => {
  const matrix = readMatrix();

  assert.equal(Array.isArray(matrix.nonClaims), true);
  assert.equal(matrix.nonClaims.length, 8);

  for (const required of requiredNonClaims) {
    assert.equal(
      matrix.nonClaims.some((claim) => claim.toLowerCase().includes(required.toLowerCase())),
      true,
      `nonClaims should include ${required}`
    );
  }
});
