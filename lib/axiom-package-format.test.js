const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const {
  validateAxiomPackage,
  validateAxiomPackageFile,
  AXIOM_PACKAGE_FORMAT_VERSION,
} = require('./axiom-package-format');

const fixtureDir = path.join(__dirname, '..', 'specs', 'axiom-package-format', '0.1', 'examples');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function validateFixture(name) {
  return validateAxiomPackageFile(path.join(fixtureDir, name));
}

test('axiom package format version is 0.1', () => {
  assert.equal(AXIOM_PACKAGE_FORMAT_VERSION, '0.1');
});

test('valid package fixtures pass', () => {
  for (const name of [
    'package.trust-receipt-bundle.axiom.json',
    'package.github-pr-review.axiom.json',
    'package.causal-simulation.axiom.json',
    'package.candidate-claims.axiom.json',
  ]) {
    const result = validateFixture(name);
    assert.equal(result.ok, true, `${name} should pass`);
    assert.equal(result.errors.length, 0, `${name} should not have errors`);
  }
});

test('manifest validation fails on required field violations', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  delete pkg.manifest.packageId;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => err.field === 'manifest.packageId'));

  const wrongFormat = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongFormat.manifest.format = 'wrong';
  assert.equal(validateAxiomPackage(wrongFormat).ok, false);

  const wrongFormatVersion = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongFormatVersion.manifest.formatVersion = '0.2';
  assert.equal(validateAxiomPackage(wrongFormatVersion).ok, false);

  const wrongAtpVersion = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongAtpVersion.manifest.atpVersion = '0.2';
  assert.equal(validateAxiomPackage(wrongAtpVersion).ok, false);

  const missingWorkspace = readFixture('package.trust-receipt-bundle.axiom.json');
  delete missingWorkspace.manifest.workspaceId;
  assert.equal(validateAxiomPackage(missingWorkspace).ok, false);
});

test('object validation rejects invalid embedded ATP data', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  pkg.objects.provenanceRecords[0].provenanceId = '';
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => String(err.field).includes('objects.provenanceRecords[0].provenanceId')));
});

test('trust receipt canonical state is enforced', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  pkg.objects.trustReceipts[0].canonical = false;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => String(err.field).includes('objects.trustReceipts[0].canonical')));
});

test('pending candidate remains non-canonical and valid', () => {
  const pkg = readFixture('package.github-pr-review.axiom.json');
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(pkg.objects.candidateClaims[0].status, 'pending');
  assert.equal(pkg.objects.candidateClaims[0].recommendation, 'flag');
});

test('object count mismatch returns warning', () => {
  const pkg = readFixture('package.candidate-claims.axiom.json');
  pkg.manifest.objectCounts.candidateClaims = 99;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.field === 'manifest.objectCounts.candidateClaims'));
});

test('x-* extension fields are tolerated and do not override core fields', () => {
  const pkg = readFixture('package.causal-simulation.axiom.json');
  pkg['x-axiom-experimental'] = { enabled: true };
  pkg.manifest['x-axiom-experimental'] = { note: 'ok' };
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, true);
});

test('validateAxiomPackageFile handles temp files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-package-'));
  const tempFile = path.join(tempDir, 'temp.axiom.json');
  fs.writeFileSync(tempFile, JSON.stringify(readFixture('package.trust-receipt-bundle.axiom.json'), null, 2));
  const result = validateAxiomPackageFile(tempFile);
  assert.equal(result.ok, true);
});
