const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'runtime-reader');

const validFixtures = [
  'valid-minimal-readable-package.json',
  'valid-with-explicit-nonclaims.json',
  'valid-with-provenance-metadata.json',
  'valid-with-reasoning-metadata.json',
  'valid-with-route-receipt-claim.json'
];

const invalidFixtures = [
  'invalid-malformed-provenance-metadata.json',
  'invalid-malformed-reasoning-metadata.json',
  'invalid-missing-issuer.json',
  'invalid-missing-package-identity.json',
  'invalid-missing-route-receipt-when-claimed.json',
  'invalid-missing-subject.json',
  'invalid-missing-verdict.json',
  'invalid-trust-verification-status-language.json',
  'invalid-unsupported-runtime-claim.json',
  'invalid-unsupported-schema-version.json'
];

const expectedReasonCategories = {
  'valid-minimal-readable-package.json': 'valid_package_candidate',
  'valid-with-explicit-nonclaims.json': 'valid_nonclaims_preserved',
  'valid-with-provenance-metadata.json': 'valid_provenance_metadata',
  'valid-with-reasoning-metadata.json': 'valid_reasoning_metadata',
  'valid-with-route-receipt-claim.json': 'valid_route_receipt_metadata',
  'invalid-malformed-provenance-metadata.json': 'malformed_provenance_metadata',
  'invalid-malformed-reasoning-metadata.json': 'malformed_reasoning_metadata',
  'invalid-missing-issuer.json': 'missing_issuer_identity',
  'invalid-missing-package-identity.json': 'missing_trust_package_identity',
  'invalid-missing-route-receipt-when-claimed.json': 'missing_route_receipt_metadata',
  'invalid-missing-subject.json': 'missing_subject_reference',
  'invalid-missing-verdict.json': 'missing_verdict_metadata',
  'invalid-trust-verification-status-language.json': 'trust_verification_status_claim',
  'invalid-unsupported-runtime-claim.json': 'runtime_reader_claim',
  'invalid-unsupported-schema-version.json': 'unsupported_schema_version'
};

const expectedValidNonClaims = {
  'valid-minimal-readable-package.json': [
    'fixture_only',
    'not_trusted',
    'not_signed',
    'not_verified',
    'not_transported'
  ],
  'valid-with-explicit-nonclaims.json': [
    'does_not_prove_runtime_reader',
    'does_not_prove_runtime_writer',
    'does_not_prove_signing',
    'does_not_prove_verification',
    'does_not_prove_a2a',
    'does_not_prove_connector_enforcement',
    'does_not_prove_marketplace',
    'does_not_prove_agentaction_policy'
  ],
  'valid-with-provenance-metadata.json': [
    'provenance_metadata_only',
    'no_cryptographic_verification'
  ],
  'valid-with-reasoning-metadata.json': [
    'reasoning_metadata_only',
    'no_trust_decision'
  ],
  'valid-with-route-receipt-claim.json': [
    'route_receipt_metadata_only',
    'no_runtime_exchange',
    'no_transport'
  ]
};

const allFixtures = [...validFixtures, ...invalidFixtures];
const validFixtureSet = new Set(validFixtures);
const invalidFixtureSet = new Set(invalidFixtures);
const validStatuses = new Set(['readable']);
const invalidStatuses = new Set(['malformed', 'missing_required_field', 'unsupported_claim', 'unsupported_version']);
const forbiddenContentPattern = /secret|token|credential|password|https?:\/\/|Date\.now|Math\.random|new Date|C:\\|\/Users\/|\/home\//i;
const forbiddenTrustedStatusPattern = /trusted|verified|signed|authorized|enforced|marketplace_ready/i;

function listFixtureFiles() {
  return fs
    .readdirSync(fixtureRoot)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}

function readFixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'));
}

function readFixtureText(relativePath) {
  return fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
}

function assertBaseFixtureShape(fixture, relativePath) {
  assert.equal(typeof fixture.fixtureType, 'string', `${relativePath} should define fixtureType`);
  assert.equal(typeof fixture.expected, 'object', `${relativePath} should define expected`);
  assert.equal(typeof fixture.expected.status, 'string', `${relativePath} should define expected.status`);
  assert.equal(typeof fixture.expected.reasonCategory, 'string', `${relativePath} should define expected.reasonCategory`);
  assert.notEqual(fixture.expected.reasonCategory.trim(), '', `${relativePath} reasonCategory should not be blank`);
  assert.equal(typeof fixture.candidate, 'object', `${relativePath} should define candidate`);
}

function assertReadableCandidateShape(fixture, relativePath) {
  assert.equal(fixture.candidate.schemaVersion, 'v5.shared_trust_package.writer_input.v1', `${relativePath} schemaVersion should stay supported`);
  assert.equal(typeof fixture.candidate.packageId, 'string', `${relativePath} should define packageId`);
  assert.equal(typeof fixture.candidate.issuer.agentId, 'string', `${relativePath} should define issuer.agentId`);
  assert.equal(typeof fixture.candidate.issuer.workspaceId, 'string', `${relativePath} should define issuer.workspaceId`);
  assert.equal(typeof fixture.candidate.subject.type, 'string', `${relativePath} should define subject.type`);
  assert.equal(typeof fixture.candidate.subject.id, 'string', `${relativePath} should define subject.id`);
  assert.equal(typeof fixture.candidate.verdict.status, 'string', `${relativePath} should define verdict.status`);
  assert.equal(Array.isArray(fixture.candidate.nonClaims), true, `${relativePath} should define nonClaims array`);
}

test('V5 runtime reader fixtures expose exactly the expected 15 JSON files', () => {
  assert.deepEqual(listFixtureFiles(), [...allFixtures].sort());
});

test('V5 runtime reader fixtures keep deterministic expected status metadata', () => {
  for (const relativePath of allFixtures) {
    const fixture = readFixture(relativePath);
    const text = readFixtureText(relativePath);

    assertBaseFixtureShape(fixture, relativePath);
    assert.equal(fixture.expected.reasonCategory, expectedReasonCategories[relativePath], `${relativePath} reasonCategory should stay canonical`);
    assert.equal(forbiddenContentPattern.test(text), false, `${relativePath} should not include environment-bound or secret-like content`);
  }
});

test('V5 runtime reader valid fixtures stay readable without trust or verification claims', () => {
  for (const relativePath of validFixtures) {
    const fixture = readFixture(relativePath);

    assert.equal(fixture.fixtureType, 'valid_reader_candidate', `${relativePath} should stay a valid reader candidate`);
    assert.equal(validStatuses.has(fixture.expected.status), true, `${relativePath} should use readable-domain status`);
    assertReadableCandidateShape(fixture, relativePath);
    assert.deepEqual(fixture.candidate.nonClaims, expectedValidNonClaims[relativePath], `${relativePath} nonClaims should stay exact`);
    assert.equal(forbiddenTrustedStatusPattern.test(fixture.candidate.verdict.status), false, `${relativePath} must not claim trust status`);
    assert.equal(JSON.stringify(fixture.candidate.claims || {}).includes('runtimeReaderImplemented'), false, `${relativePath} must not claim runtime reader implementation`);
    assert.equal(JSON.stringify(fixture.candidate.claims || {}).includes('runtimeExchange'), false, `${relativePath} must not claim runtime exchange`);
  }
});

test('V5 runtime reader invalid fixtures stay fail-closed by expected category', () => {
  for (const relativePath of invalidFixtures) {
    const fixture = readFixture(relativePath);

    assert.equal(fixture.fixtureType, 'invalid_reader_candidate', `${relativePath} should stay an invalid reader candidate`);
    assert.equal(invalidStatuses.has(fixture.expected.status), true, `${relativePath} should use fail-closed status language`);
    assert.notEqual(fixture.expected.status, 'readable', `${relativePath} must not be expected readable`);
    assert.equal(invalidFixtureSet.has(relativePath), true);
  }
});

test('V5 runtime reader fixture corpus preserves explicit non-claim boundaries', () => {
  const explicitNonClaims = readFixture('valid-with-explicit-nonclaims.json').candidate.nonClaims;
  const requiredNonClaims = [
    'does_not_prove_runtime_reader',
    'does_not_prove_runtime_writer',
    'does_not_prove_signing',
    'does_not_prove_verification',
    'does_not_prove_a2a',
    'does_not_prove_connector_enforcement',
    'does_not_prove_marketplace',
    'does_not_prove_agentaction_policy'
  ];

  for (const nonClaim of requiredNonClaims) {
    assert.equal(explicitNonClaims.includes(nonClaim), true, `explicit nonClaims should include ${nonClaim}`);
  }

  for (const relativePath of allFixtures) {
    const fixture = readFixture(relativePath);
    if (Array.isArray(fixture.candidate.nonClaims)) {
      assert.equal(fixture.candidate.nonClaims.length > 0, true, `${relativePath} nonClaims should not be empty when present`);
    }
    assert.equal(validFixtureSet.has(relativePath) || invalidFixtureSet.has(relativePath), true);
  }
});

test('V5 runtime reader unsupported-claim fixtures remain blocked examples, not capabilities', () => {
  const runtimeClaimFixture = readFixture('invalid-unsupported-runtime-claim.json');
  const trustStatusFixture = readFixture('invalid-trust-verification-status-language.json');
  const routeReceiptClaimFixture = readFixture('invalid-missing-route-receipt-when-claimed.json');

  assert.equal(runtimeClaimFixture.candidate.claims.runtimeReaderImplemented, true);
  assert.equal(runtimeClaimFixture.expected.status, 'unsupported_claim');
  assert.equal(trustStatusFixture.candidate.verdict.status, 'verified');
  assert.equal(trustStatusFixture.expected.status, 'unsupported_claim');
  assert.equal(routeReceiptClaimFixture.candidate.claims.routeReceiptSupport, true);
  assert.equal(routeReceiptClaimFixture.expected.status, 'missing_required_field');
  assert.equal(Object.hasOwn(routeReceiptClaimFixture.candidate, 'routeReceipt'), false);
});
